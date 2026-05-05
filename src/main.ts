import { normalizePath, TFolder, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, setIcon } from "obsidian";
import { VaultApi } from "./vaultApi";
import { WebSocketClient, ConnectionStatus } from "./websocketClient";
import { AlertModal } from "./alertModal";
import { t } from "./i18n";


interface GTCSyncSettings {
  websocketUrl: string;
  websocketToken: string;
  autoConnect: boolean;
  debug: boolean;
}

const DEFAULT_SETTINGS: GTCSyncSettings = {
  websocketUrl: "ws://127.0.0.1:8080",
  websocketToken: "",
  autoConnect: true,
  debug: false,
};

// loadLocalStorage plutôt que loadData/saveData pour que les paramètres restent
// locaux à l'appareil et ne soient pas propagés via Obsidian Sync.
const LOCAL_SETTINGS_KEY = "gtc-sync-plugin-local-settings";


export default class GTCSyncPlugin extends Plugin {
  settings!: GTCSyncSettings;
  vaultApi!: VaultApi;
  wsClient: WebSocketClient | null = null;
  private activeFileTimer: number | null = null;
  private statusBarEl!: HTMLElement;
  private ribbonStatusEl!: HTMLElement;
  private currentStatus: ConnectionStatus = "disconnected";
  private disconnectedModalOpen = false;

  private debugLog(...args: unknown[]): void {
    if (this.settings.debug)
      console.error("[GTC-Sync]", ...args);
  }

  setConnectionStatus(status: ConnectionStatus): void {
    // On conserve l'état auth-error même si le serveur envoie ensuite "disconnected".
    if (status === "disconnected" && this.currentStatus === "auth-error") {
      return;
    }

    const icons: Record<ConnectionStatus, string> = {
      connecting: "loader",
      connected: "wifi",
      disconnected: "wifi-off",
      "auth-error": "shield-off",
    };
    const tooltips: Record<ConnectionStatus, string> = {
      connecting: t("statusConnecting"),
      connected: t("statusConnected"),
      disconnected: t("statusDisconnected"),
      "auth-error": t("statusAuthError"),
    };

    this.statusBarEl.setText("Gtc sync : ●");
    this.statusBarEl.title = tooltips[status];
    this.statusBarEl.setAttribute("data-gtc-status", status);

    setIcon(this.ribbonStatusEl, icons[status]);
    this.ribbonStatusEl.title = tooltips[status];
    this.ribbonStatusEl.setAttribute("data-gtc-status", status);

    this.currentStatus = status;
  }

  private showDisconnectedModal(): void {
    if (this.disconnectedModalOpen) return;
    this.disconnectedModalOpen = true;

    new AlertModal(
      this.app,
      t("modalDisconnectedTitle"),
      t("modalDisconnectedMessage"),
      "warning",
      {
        label: t("btnReconnect"),
        onClick: () => this.startWebSocket(),
      },
      () => { this.disconnectedModalOpen = false; },
    ).open();
  }

  onSessionReplaced(): void {
    new AlertModal(
      this.app,
      t("modalSessionReplacedTitle"),
      t("modalSessionReplacedMessage"),
      "warning",
      {
        label: t("btnReconnect"),
        onClick: () => this.startWebSocket(),
      },
    ).open();
  }

  onload() {
    this.loadSettings();

    this.vaultApi = new VaultApi(this.app);

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("gtc-sync-status");

    // ribbonStatusEl doit être créé avant le premier appel à setConnectionStatus.
    this.ribbonStatusEl = this.addRibbonIcon("wifi-off", t("statusDisconnected"), () => { });
    this.ribbonStatusEl.addClass("gtc-sync-ribbon-status");

    this.setConnectionStatus("disconnected");

    this.addSettingTab(new GTCSyncPluginSettingTab(this.app, this));

    this.addRibbonIcon("square-pen", t("ribbonQuickNote"), async () => {
      await this.createQuickNote();
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        menu.addItem((item) => {
          item
            .setTitle(t("menuCreateQuickNote"))
            .setIcon("square-pen")
            .onClick(async () => {
              await this.createQuickNote(file);
            });
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        menu.addItem((item) => {
          item
            .setTitle(t("menuSendToQuickNote"))
            .setIcon("send")
            .onClick(async () => {
              await this.sendToQuickNote(file);
            });
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile | null) => {
        if (!file || file.extension !== "md") return;
        if (this.currentStatus === "connected") return;

        const cache = this.app.metadataCache.getFileCache(file);
        const idNote = cache?.frontmatter?.["IdNote"] as string | undefined;
        if (!idNote) return;

        this.showDisconnectedModal();
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const serverInitiated = this.wsClient?.updatingFiles.includes(file.path) ?? false;

        // Délai pour laisser le metadataCache se mettre à jour après le renommage.
        window.setTimeout(() => {
          void (async () => {
            if (!serverInitiated) {
              await this.handleFileModified(file);
            }

            // Syncer les fichiers dont les références ont été mises à jour par le renommage.
            const resolvedLinks = this.app.metadataCache.resolvedLinks;
            for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
              if (!(file.path in targets)) continue;
              const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
              if (!(sourceFile instanceof TFile)) continue;
              const cache = this.app.metadataCache.getFileCache(sourceFile);
              if (!cache?.frontmatter?.["IdNote"]) continue;
              await this.handleFileModified(sourceFile);
            }
          })();
        }, 500);
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;

        // Restreint au fichier actif pour ne pas propager les modifications
        // apportées par d'autres utilisateurs via Obsidian Sync.
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.path !== file.path) return;

        if (this.wsClient?.updatingFiles.includes(file.path)) return;

        if (this.activeFileTimer !== null) window.clearTimeout(this.activeFileTimer);

        this.activeFileTimer = window.setTimeout(() => {
          this.activeFileTimer = null;
          void this.handleFileModified(file);
        }, 1000);
      }),
    );

    this.addCommand({
      id: "create-quick-note",
      name: t("cmdCreateQuickNote"),
      callback: async () => {
        await this.createQuickNote();
      },
    });

    this.addCommand({
      id: "connect-websocket",
      name: t("cmdConnectWebSocket"),
      callback: () => {
        this.startWebSocket();
        new Notice(t("noticeWsConnected"));
      },
    });

    this.addCommand({
      id: "disconnect-websocket",
      name: t("cmdDisconnectWebSocket"),
      callback: () => {
        this.stopWebSocket();
        new Notice(t("noticeWsDisconnected"));
      },
    });

    if (this.settings.autoConnect) {
      this.startWebSocket();
    }
  }

  onunload() {
    if (this.activeFileTimer !== null) window.clearTimeout(this.activeFileTimer);
    this.stopWebSocket();
  }

  private async setFrontmatterProperty(file: TFile, key: string, value: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      (fm as Record<string, unknown>)[key] = value;
    });
  }

  async sendToQuickNote(target?: TAbstractFile): Promise<void> {
    try {
      if (!(target instanceof TFile)) return;

      if (!this.wsClient) {
        throw new Error(t("errWsNotInit"));
      }

      const idNote = await this.wsClient.getNoteId();
      await this.setFrontmatterProperty(target, "IdNote", idNote);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(t("noticeSendToQuickNoteFailed", { message }), 8000);
      console.error("[GTCSyncPlugin] sendToQuickNote error:", error);
    }
  }

  async createQuickNote(target?: TAbstractFile): Promise<void> {
    try {
      if (!this.wsClient) {
        throw new Error(t("errWsNotInit"));
      }

      const idNote = await this.wsClient.getNoteId();
      const folderPath = this.resolveQuickNoteFolder(target);
      const fileName = this.buildQuickNoteFileName();
      const fullPath = normalizePath(`${folderPath}/${fileName}`);

      const content = ["---", `IdNote: ${idNote}`, "---", ""].join("\n");

      this.wsClient.updatingFiles.push(fullPath);
      window.setTimeout(() => {
        this.wsClient?.updatingFiles.remove(fullPath);
      }, 2000);

      const createdFile = await this.app.vault.create(fullPath, content);
      new Notice(t("noticeQuickNoteCreated", { path: createdFile.path }));
      await this.app.workspace.getLeaf(true).openFile(createdFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(t("noticeQuickNoteFailed", { message }), 8000);
      console.error("[GTCSyncPlugin] createQuickNote error:", error);
    }
  }

  private resolveQuickNoteFolder(target?: TAbstractFile): string {
    if (target instanceof TFolder) return target.path;
    if (target instanceof TFile) return target.parent?.path ?? "";

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile instanceof TFile) return activeFile.parent?.path ?? "";

    return "";
  }

  private buildQuickNoteFileName(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `Quick Note ${yyyy}-${mm}-${dd} ${hh}-${mi}-${ss}.md`;
  }

  restartWebSocket(){
    this.stopWebSocket();
    this.startWebSocket();
  }

  private async handleFileModified(file: TAbstractFile): Promise<void> {
    try {
      if (!(file instanceof TFile) || file.extension !== "md") return;

      const cache = this.app.metadataCache.getFileCache(file);
      const IdNote = cache?.frontmatter?.["IdNote"] as string | undefined;
      if (!IdNote) return;

      if (this.currentStatus !== "connected") {
        this.showDisconnectedModal();
        return;
      }

      const content = await this.app.vault.read(file);
      this.debugLog("note.saved →", file.path);
      const response = await this.wsClient?.saveNote({
        path: file.path,
        IdNote,
        contentLines: content.split("\n"),
        metadata: {
          createdAt: new Date(file.stat.ctime).toISOString(),
          modifiedAt: new Date(file.stat.mtime).toISOString(),
          createdAtMs: file.stat.ctime,
          modifiedAtMs: file.stat.mtime,
        },
      });

      this.debugLog("note.saved ←", response);
      if (typeof response !== "object" || response === null) {
        throw new Error(t("errInvalidResponseSave"));
      }

      const result = (response as Record<string, unknown>).result;
      if (typeof result !== "object" || result === null) {
        throw new Error(t("errInvalidResultSave"));
      }

      const resultObj = result as Record<string, unknown>;
      if (resultObj.Type === "Error") {
        this.debugLog("note.saved ←", resultObj);

        switch (String(resultObj.Code)) {
          case "74":
            new AlertModal(
              this.app,
              t("modalSaveErrorTitle"),
              t("modalNoteReservedMessage"),
            ).open();
            break;
          case "78":
            new AlertModal(
              this.app,
              t("modalSaveErrorTitle"),
              t("modalNoteUnexistingMessage"),
            ).open();
            break;
          default:
            new AlertModal(
              this.app,
              t("modalSaveErrorTitle"),
              t("modalErrorMessage", { code: String(resultObj.Code), message: typeof resultObj.Message === "string" ? resultObj.Message : "" }),
            ).open();
        }
        return;
      }



      new Notice(t("noteSynced"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(t("noticeSyncFailed", { message }), 8000);
      console.error("[GTCSyncPlugin] Erreur handleFileModified:", error);
    }
  }

  startWebSocket() {
    if (this.wsClient) {
      this.wsClient.stop();
      this.wsClient = null;
    }

    this.wsClient = new WebSocketClient(
      this.vaultApi,
      this.settings.websocketUrl,
      this.app,
      this.settings.websocketToken || undefined,
      (status) => this.setConnectionStatus(status),
      () => this.onSessionReplaced(),
      (...args) => this.debugLog(...args),
    );

    this.wsClient.start();
  }

  stopWebSocket() {
    if (this.wsClient) {
      this.wsClient.stop();
      this.wsClient = null;
    }
  }

  loadSettings() {
    const localData = this.app.loadLocalStorage(LOCAL_SETTINGS_KEY) as Partial<GTCSyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, localData ?? {});
  }

  saveSettings() {
    this.app.saveLocalStorage(LOCAL_SETTINGS_KEY, this.settings);
  }
}

class GTCSyncPluginSettingTab extends PluginSettingTab {
  plugin: GTCSyncPlugin;

  constructor(app: import("obsidian").App, plugin: GTCSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(t("settingsUrlName"))
      .setDesc(t("settingsUrlDesc"))
      .addText((text) =>
        text
          .setPlaceholder("ws://127.0.0.1:8080")
          .setValue(this.plugin.settings.websocketUrl)
          .onChange((value) => {
            this.plugin.settings.websocketUrl = value;
            this.plugin.saveSettings();
            this.plugin.restartWebSocket();
          }),
      );

    new Setting(containerEl)
      .setName(t("settingsTokenName"))
      .setDesc(t("settingsTokenDesc"))
      .addText((text) =>
        text
          .setPlaceholder("Token")
          .setValue(this.plugin.settings.websocketToken)
          .onChange((value) => {
            this.plugin.settings.websocketToken = value;
            this.plugin.saveSettings();
            this.plugin.restartWebSocket();
          }),
      );

    new Setting(containerEl)
      .setName(t("settingsAutoConnectName"))
      .setDesc(t("settingsAutoConnectDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoConnect)
          .onChange((value) => {
            this.plugin.settings.autoConnect = value;
            this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settingsDebugName"))
      .setDesc(t("settingsDebugDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debug)
          .onChange((value) => {
            this.plugin.settings.debug = value;
            this.plugin.saveSettings();
          }),
      );
  }
}

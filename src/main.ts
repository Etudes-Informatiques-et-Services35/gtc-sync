import { normalizePath, TFolder, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, setIcon } from "obsidian";
import { VaultApi } from "./vaultApi";
import { WebSocketClient, ConnectionStatus } from "./websocketClient";
import { AlertModal } from "./alertModal";


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
    if (this.settings.debug) console.log("[GTC-Sync]", ...args);
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
      connecting: "GTC-Sync : Connexion en cours…",
      connected: "GTC-Sync : Connecté",
      disconnected: "GTC-Sync : Déconnecté (reconnexion auto)",
      "auth-error": "GTC-Sync : Erreur d'authentification",
    };

    this.statusBarEl.setText("GTC-Sync : ●");
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
      "GTC-Sync : Déconnecté",
      "Le plugin n'est pas connecté au serveur GTC-Sync.\nLes modifications ne seront pas synchronisées.",
      "warning",
      {
        label: "Reconnecter",
        onClick: () => this.startWebSocket(),
      },
      () => { this.disconnectedModalOpen = false; },
    ).open();
  }

  onSessionReplaced(): void {
    new AlertModal(
      this.app,
      "GTC-Sync : Attention",
      "La connexion a été fermée car une autre session GTC-Sync vient de se connecter.",
      "warning",
      {
        label: "Reconnecter",
        onClick: () => this.startWebSocket(),
      },
    ).open();
  }

  async onload() {
    await this.loadSettings();

    this.vaultApi = new VaultApi(this.app);

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("gtc-sync-status");

    // ribbonStatusEl doit être créé avant le premier appel à setConnectionStatus.
    this.ribbonStatusEl = this.addRibbonIcon("wifi-off", "GTC-Sync : Déconnecté (reconnexion auto)", () => {});
    this.ribbonStatusEl.addClass("gtc-sync-ribbon-status");

    this.setConnectionStatus("disconnected");

    this.addSettingTab(new GTCSyncPluginSettingTab(this.app, this));

    this.addRibbonIcon("square-pen", "Créer une note rapide", async () => {
      await this.createQuickNote();
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        menu.addItem((item) => {
          item
            .setTitle("Créer une note rapide")
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
            .setTitle("Envoyer dans note rapide")
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
        const idNote = cache?.frontmatter?.["IdNote"];
        if (!idNote) return;

        this.showDisconnectedModal();
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const serverInitiated = this.wsClient?.updatingFiles.includes(file.path) ?? false;

        // Délai pour laisser le metadataCache se mettre à jour après le renommage.
        window.setTimeout(async () => {
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

        this.activeFileTimer = window.setTimeout(async () => {
          this.activeFileTimer = null;
          await this.handleFileModified(file);
        }, 1000);
      }),
    );

    this.addCommand({
      id: "create-quick-note",
      name: "Créer une note rapide",
      callback: async () => {
        await this.createQuickNote();
      },
    });

    this.addCommand({
      id: "connect-websocket",
      name: "Connect WebSocket",
      callback: async () => {
        await this.startWebSocket();
        new Notice("WebSocket connecté");
      },
    });

    this.addCommand({
      id: "disconnect-websocket",
      name: "Disconnect WebSocket",
      callback: async () => {
        await this.stopWebSocket();
        new Notice("WebSocket déconnecté");
      },
    });

    if (this.settings.autoConnect) {
      await this.startWebSocket();
    }
  }

  async onunload() {
    if (this.activeFileTimer !== null) window.clearTimeout(this.activeFileTimer);
    await this.stopWebSocket();
  }

  private async setFrontmatterProperty(file: TFile, key: string, value: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[key] = value;
    });
  }

  async sendToQuickNote(target?: TAbstractFile): Promise<void> {
    try {
      if (!(target instanceof TFile)) return;

      if (!this.wsClient) {
        throw new Error("WebSocket non initialisé");
      }

      const idNote = await this.wsClient.getNoteId();
      await this.setFrontmatterProperty(target, "IdNote", idNote);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Impossible de synchroniser la note rapide : ${message}`, 8000);
      console.error("[GTCSyncPlugin] sendToQuickNote error:", error);
    }
  }

  async createQuickNote(target?: TAbstractFile): Promise<void> {
    try {
      if (!this.wsClient) {
        throw new Error("WebSocket non initialisé");
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
      new Notice(`Note rapide créée : ${createdFile.path}`);
      await this.app.workspace.getLeaf(true).openFile(createdFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Impossible de créer la note rapide : ${message}`, 8000);
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

  async restartWebSocket(): Promise<void> {
    await this.stopWebSocket();
    await this.startWebSocket();
  }

  private async handleFileModified(file: TAbstractFile): Promise<void> {
    try {
      if (!(file instanceof TFile) || file.extension !== "md") return;

      const cache = this.app.metadataCache.getFileCache(file);
      const IdNote = cache?.frontmatter?.["IdNote"];
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
        throw new Error("Réponse invalide pour note.saved");
      }

      const result = (response as Record<string, unknown>).result;
      if (typeof result !== "object" || result === null) {
        throw new Error("Résultat invalide pour note.saved");
      }

      const resultObj = result as Record<string, unknown>;
      if (resultObj.Type === "Error") {
        if (String(resultObj.Code) === "74") {
          new AlertModal(
            this.app,
            "GTC-Sync : Attention",
            "La note est réservée par un autre utilisateur,\nles modifications peuvent être perdues !",
          ).open();
        } else {
          new AlertModal(
            this.app,
            "GTC-Sync : Attention",
            "Erreur " + String(resultObj.Code) + " : " + String(resultObj.Message ?? ""),
          ).open();
        }
        return;
      }

      new Notice("La note a été synchronisée.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`GTC-Sync : échec de la synchronisation — ${message}`, 8000);
      console.error("[GTCSyncPlugin] Erreur handleFileModified:", error);
    }
  }

  async startWebSocket(): Promise<void> {
    if (this.wsClient) {
      await this.wsClient.stop();
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

    await this.wsClient.start();
  }

  async stopWebSocket(): Promise<void> {
    if (this.wsClient) {
      await this.wsClient.stop();
      this.wsClient = null;
    }
  }

  async loadSettings(): Promise<void> {
    const localData = this.app.loadLocalStorage(LOCAL_SETTINGS_KEY);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, localData ?? {});
  }

  async saveSettings(): Promise<void> {
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
      .setName("WebSocket URL")
      .setDesc("Adresse du serveur WebSocket")
      .addText((text) =>
        text
          .setPlaceholder("ws://127.0.0.1:8080")
          .setValue(this.plugin.settings.websocketUrl)
          .onChange(async (value) => {
            this.plugin.settings.websocketUrl = value;
            await this.plugin.saveSettings();
            await this.plugin.restartWebSocket();
          }),
      );

    new Setting(containerEl)
      .setName("WebSocket token")
      .setDesc("Token envoyé au serveur après connexion")
      .addText((text) =>
        text
          .setPlaceholder("token")
          .setValue(this.plugin.settings.websocketToken)
          .onChange(async (value) => {
            this.plugin.settings.websocketToken = value;
            await this.plugin.saveSettings();
            await this.plugin.restartWebSocket();
          }),
      );

    new Setting(containerEl)
      .setName("Auto connect")
      .setDesc("Se reconnecter automatiquement au chargement du plugin")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoConnect)
          .onChange(async (value) => {
            this.plugin.settings.autoConnect = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Mode debug")
      .setDesc("Affiche les logs détaillés dans la console du développeur (F12)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debug)
          .onChange(async (value) => {
            this.plugin.settings.debug = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}

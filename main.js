var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => GTCSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// src/vaultApi.ts
var import_obsidian = require("obsidian");
var VaultApi = class {
  constructor(app) {
    this.app = app;
  }
  getFileByPath(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof import_obsidian.TFile)) {
      throw new Error(`Fichier introuvable: ${path}`);
    }
    return file;
  }
  async readNote(path) {
    const file = this.getFileByPath(path);
    const content = (await this.app.vault.read(file)).split("\n");
    return {
      path,
      content,
      metadata: {
        createdAt: new Date(file.stat.ctime).toISOString(),
        modifiedAt: new Date(file.stat.mtime).toISOString(),
        createdAtMs: file.stat.ctime,
        modifiedAtMs: file.stat.mtime
      }
    };
  }
  async createNote(path, content) {
    if (this.app.vault.getAbstractFileByPath(path)) {
      throw new Error(`Le fichier existe d\xE9j\xE0: ${path}`);
    }
    await this.app.vault.create(path, this.clearText(content.join("\n")));
    return { path };
  }
  async moveNote(path, newPath) {
    const file = this.getFileByPath(path);
    await this.app.fileManager.renameFile(file, newPath);
    return { path };
  }
  async replaceNote(path, content) {
    const file = this.getFileByPath(path);
    await this.app.vault.modify(file, this.clearText(content.join("\n")));
    return { path };
  }
  async openNote(name) {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName) {
      throw new Error("Nom de note vide");
    }
    const matches = this.app.vault.getMarkdownFiles().filter((f) => {
      const basename = f.basename.trim().toLowerCase();
      const filename = f.name.trim().toLowerCase();
      const path = f.path.trim().toLowerCase();
      return basename === normalizedName || filename === normalizedName || path === normalizedName + ".md";
    });
    if (matches.length === 0) {
      throw new Error(`Note introuvable: ${name}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Plusieurs notes portent ce nom: ${name} (${matches.map((f) => f.path).join(", ")})`
      );
    }
    await this.app.workspace.getLeaf(true).openFile(matches[0]);
    return { path: matches[0].path };
  }
  async findByProperty(property, value) {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter;
      if (!frontmatter) continue;
      const frontmatterValue = frontmatter[property];
      if (frontmatterValue == value || String(frontmatterValue) === String(value)) {
        return {
          path: file.path,
          properties: frontmatter
        };
      }
    }
    return null;
  }
  clearText(text) {
    return text.replace("\\t", "	");
  }
};

// src/websocketClient.ts
var import_obsidian2 = require("obsidian");
var WebSocketClient = class {
  constructor(vaultApi, url, app, token, onStatusChange, onSessionReplaced, debugLog) {
    this.vaultApi = vaultApi;
    this.url = url;
    this.app = app;
    this.token = token;
    this.onStatusChange = onStatusChange;
    this.onSessionReplaced = onSessionReplaced;
    this.debugLog = debugLog;
    this.ws = null;
    this.running = false;
    this.reconnectTimer = null;
    this.sessionReplaced = false;
    // Chemins des fichiers modifiés par une commande distante en cours.
    // Permet d'ignorer l'event vault "modify" qu'elles génèrent et d'éviter une boucle de sync.
    this.updatingFiles = [];
    // Requêtes plugin → serveur en attente de réponse, indexées par UUID.
    // Chaque entrée est résolue ou rejetée à réception du message correspondant (même id).
    this.pendingRequests = /* @__PURE__ */ new Map();
  }
  async start() {
    this.running = true;
    this.sessionReplaced = false;
    this.connect();
  }
  async stop() {
    this.running = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPendingRequests("WebSocket ferm\xE9");
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
  connect() {
    this.debugLog?.("connexion \xE0", this.url);
    this.onStatusChange?.("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.debugLog?.("socket ouverte");
      if (this.token) {
        this.debugLog?.("envoi auth");
        ws.send(JSON.stringify({ type: "auth", token: this.token }));
      } else {
        this.onStatusChange?.("connected");
      }
    };
    ws.onmessage = async (event) => {
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        const parsed = JSON.parse(raw);
        this.debugLog?.("\u2193", parsed);
        if (parsed.type === "auth.ok") {
          this.debugLog?.("authentification OK");
          this.onStatusChange?.("connected");
          return;
        }
        if (parsed.type === "auth.error") {
          console.error("[WS] authentification \xE9chou\xE9e:", parsed.error);
          this.onStatusChange?.("auth-error");
          return;
        }
        if (parsed.type === "session.replaced") {
          console.warn("[WS] session remplac\xE9e par une autre connexion");
          this.sessionReplaced = true;
          this.running = false;
          return;
        }
        if (typeof parsed.id === "string" && this.pendingRequests.has(parsed.id)) {
          const pending = this.pendingRequests.get(parsed.id);
          window.clearTimeout(pending.timeout);
          this.pendingRequests.delete(parsed.id);
          if (parsed.ok === false) {
            pending.reject(new Error(typeof parsed.error === "string" ? parsed.error : "Erreur inconnue"));
            return;
          }
          pending.resolve(parsed);
          return;
        }
        const command = this.parseCommand(parsed);
        const response = await this.executeCommand(command);
        this.debugLog?.("\u2191", response);
        ws.send(JSON.stringify(response));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new import_obsidian2.Notice(`GTC-Sync : erreur de traitement du message \u2014 ${message}`, 8e3);
        ws.send(JSON.stringify({ id: "unknown", ok: false, error: message }));
      }
    };
    ws.onerror = () => {
      console.error("[WS] erreur websocket");
    };
    ws.onclose = () => {
      console.warn("[WS] connexion ferm\xE9e");
      this.rejectPendingRequests("Connexion WebSocket ferm\xE9e");
      if (this.sessionReplaced) {
        this.onStatusChange?.("disconnected");
        this.onSessionReplaced?.();
        return;
      }
      this.onStatusChange?.("disconnected");
      if (this.running) {
        this.debugLog?.("reconnexion dans 3 s");
        this.reconnectTimer = window.setTimeout(() => this.connect(), 3e3);
      }
    };
  }
  rejectPendingRequests(reason) {
    for (const [id, pending] of this.pendingRequests.entries()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }
  generateRequestId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  async saveNote(payload) {
    return this.request("note.saved", payload);
  }
  async getNoteId() {
    const response = await this.request("note.getId");
    if (typeof response !== "object" || response === null) {
      throw new Error("R\xE9ponse invalide pour note.getId");
    }
    const result = response.result;
    if (typeof result !== "object" || result === null) {
      throw new Error("R\xE9sultat invalide pour note.getId");
    }
    const idNote = result.idNote;
    if (typeof idNote !== "string" || !idNote.trim()) {
      throw new Error("idNote manquant dans la r\xE9ponse");
    }
    return idNote;
  }
  async request(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket non connect\xE9");
    }
    const id = this.generateRequestId();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout en attente de r\xE9ponse pour ${type}`));
      }, 1e4);
      const message = { id, type, ...payload ?? {} };
      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.debugLog?.("\u2191", message);
      this.ws.send(JSON.stringify(message));
    });
  }
  parseCommand(value) {
    if (typeof value !== "object" || value === null) {
      throw new Error("Message invalide: objet attendu");
    }
    const obj = value;
    if (typeof obj.id !== "string") {
      throw new Error("Message invalide: id manquant");
    }
    if (obj.type === "check") {
      return { id: obj.id, type: "check" };
    }
    if (obj.type === "note.read") {
      if (typeof obj.path !== "string") throw new Error("note.read: path manquant");
      return { id: obj.id, type: "note.read", path: obj.path };
    }
    if (obj.type === "note.create") {
      if (typeof obj.path !== "string") throw new Error("note.create: path manquant");
      if (!Array.isArray(obj.content)) throw new Error("note.create: content manquant");
      return { id: obj.id, type: "note.create", path: obj.path, content: obj.content };
    }
    if (obj.type === "note.replace") {
      if (typeof obj.path !== "string") throw new Error("note.replace: path manquant");
      if (!Array.isArray(obj.content)) throw new Error("note.replace: content manquant");
      return { id: obj.id, type: "note.replace", path: obj.path, content: obj.content };
    }
    if (obj.type === "note.move") {
      if (typeof obj.path !== "string" || typeof obj.newPath !== "string") {
        throw new Error("note.move: path manquant");
      }
      return { id: obj.id, type: "note.move", path: obj.path, newPath: obj.newPath };
    }
    if (obj.type === "note.findByProperty") {
      if (typeof obj.property !== "string") throw new Error("note.findByProperty: property manquant");
      const val = obj.value;
      if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
        throw new Error("note.findByProperty: value invalide");
      }
      return { id: obj.id, type: "note.findByProperty", property: obj.property, value: val };
    }
    if (obj.type === "note.open") {
      if (typeof obj.path !== "string") throw new Error("note.open: path manquant");
      return { id: obj.id, type: "note.open", path: obj.path };
    }
    throw new Error(`Type de commande inconnu: ${String(obj.type)}`);
  }
  async executeCommand(command) {
    try {
      switch (command.type) {
        case "check":
          return { id: command.id, ok: true, result: true };
        case "note.read": {
          const result = await this.vaultApi.readNote(command.path);
          return { id: command.id, ok: true, result };
        }
        case "note.create": {
          this.updatingFiles.push(command.path);
          window.setTimeout(() => this.updatingFiles.remove(command.path), 3e3);
          const result = await this.vaultApi.createNote(command.path, command.content);
          return { id: command.id, ok: true, result };
        }
        case "note.move": {
          this.updatingFiles.push(command.newPath);
          window.setTimeout(() => this.updatingFiles.remove(command.newPath), 3e3);
          const result = await this.vaultApi.moveNote(command.path, command.newPath);
          return { id: command.id, ok: true, result };
        }
        case "note.replace": {
          this.updatingFiles.push(command.path);
          window.setTimeout(() => this.updatingFiles.remove(command.path), 3e3);
          const result = await this.vaultApi.replaceNote(command.path, command.content);
          return { id: command.id, ok: true, result };
        }
        case "note.findByProperty": {
          const result = await this.vaultApi.findByProperty(command.property, command.value);
          if (!result) return { id: command.id, ok: false, error: "Not found" };
          return { id: command.id, ok: true, result };
        }
        case "note.open": {
          const result = await this.vaultApi.openNote(command.path);
          return { id: command.id, ok: true, result };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new import_obsidian2.Notice(`GTC-Sync : \xE9chec de ${command.type} \u2014 ${message}`, 8e3);
      return { id: command.id, ok: false, error: message };
    }
  }
};

// src/alertModal.ts
var import_obsidian3 = require("obsidian");
var _AlertModal = class _AlertModal extends import_obsidian3.Modal {
  constructor(app, title, message, variant = "warning", action, onCloseCallback) {
    super(app);
    this.title = title;
    this.message = message;
    this.variant = variant;
    this.action = action;
    this.onCloseCallback = onCloseCallback;
    _AlertModal.nbinstances += 1;
  }
  destroy() {
    _AlertModal.nbinstances -= 1;
  }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.title);
    contentEl.empty();
    contentEl.addClass("gtc-alert");
    contentEl.addClass(`gtc-alert--${this.variant}`);
    const body = contentEl.createDiv({ cls: "gtc-alert__body" });
    const iconEl = body.createDiv({ cls: "gtc-alert__icon" });
    (0, import_obsidian3.setIcon)(iconEl, this.variant === "error" ? "alert-circle" : "alert-triangle");
    body.createDiv({
      cls: "gtc-alert__message",
      text: this.message
    });
    const buttonRow = contentEl.createDiv({ cls: "gtc-alert__buttons" });
    if (this.action) {
      const action = this.action;
      const actionButton = buttonRow.createEl("button", {
        text: action.label,
        cls: "mod-cta"
      });
      actionButton.addEventListener("click", () => {
        this.close();
        action.onClick();
      });
    }
    const okButton = buttonRow.createEl("button", { text: "OK" });
    okButton.addEventListener("click", () => this.close());
  }
  onClose() {
    this.contentEl.empty();
    this.onCloseCallback?.();
  }
};
_AlertModal.nbinstances = 0;
var AlertModal = _AlertModal;

// src/main.ts
var DEFAULT_SETTINGS = {
  websocketUrl: "ws://127.0.0.1:8080",
  websocketToken: "",
  autoConnect: true,
  debug: false
};
var LOCAL_SETTINGS_KEY = "gtc-sync-plugin-local-settings";
var GTCSyncPlugin = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    this.wsClient = null;
    this.activeFileTimer = null;
    this.currentStatus = "disconnected";
    this.disconnectedModalOpen = false;
  }
  debugLog(...args) {
    if (this.settings.debug) console.log("[GTC-Sync]", ...args);
  }
  setConnectionStatus(status) {
    if (status === "disconnected" && this.currentStatus === "auth-error") {
      return;
    }
    const icons = {
      connecting: "loader",
      connected: "wifi",
      disconnected: "wifi-off",
      "auth-error": "shield-off"
    };
    const tooltips = {
      connecting: "GTC-Sync : Connexion en cours\u2026",
      connected: "GTC-Sync : Connect\xE9",
      disconnected: "GTC-Sync : D\xE9connect\xE9 (reconnexion auto)",
      "auth-error": "GTC-Sync : Erreur d'authentification"
    };
    this.statusBarEl.setText("GTC-Sync : \u25CF");
    this.statusBarEl.title = tooltips[status];
    this.statusBarEl.setAttribute("data-gtc-status", status);
    (0, import_obsidian4.setIcon)(this.ribbonStatusEl, icons[status]);
    this.ribbonStatusEl.title = tooltips[status];
    this.ribbonStatusEl.setAttribute("data-gtc-status", status);
    this.currentStatus = status;
  }
  showDisconnectedModal() {
    if (this.disconnectedModalOpen) return;
    this.disconnectedModalOpen = true;
    new AlertModal(
      this.app,
      "GTC-Sync : D\xE9connect\xE9",
      "Le plugin n'est pas connect\xE9 au serveur GTC-Sync.\nLes modifications ne seront pas synchronis\xE9es.",
      "warning",
      {
        label: "Reconnecter",
        onClick: () => this.startWebSocket()
      },
      () => {
        this.disconnectedModalOpen = false;
      }
    ).open();
  }
  onSessionReplaced() {
    new AlertModal(
      this.app,
      "GTC-Sync : Attention",
      "La connexion a \xE9t\xE9 ferm\xE9e car une autre session GTC-Sync vient de se connecter.",
      "warning",
      {
        label: "Reconnecter",
        onClick: () => this.startWebSocket()
      }
    ).open();
  }
  async onload() {
    await this.loadSettings();
    this.vaultApi = new VaultApi(this.app);
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("gtc-sync-status");
    this.ribbonStatusEl = this.addRibbonIcon("wifi-off", "GTC-Sync : D\xE9connect\xE9 (reconnexion auto)", () => {
    });
    this.ribbonStatusEl.addClass("gtc-sync-ribbon-status");
    this.setConnectionStatus("disconnected");
    this.addSettingTab(new GTCSyncPluginSettingTab(this.app, this));
    this.addRibbonIcon("square-pen", "Cr\xE9er une note rapide", async () => {
      await this.createQuickNote();
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        menu.addItem((item) => {
          item.setTitle("Cr\xE9er une note rapide").setIcon("square-pen").onClick(async () => {
            await this.createQuickNote(file);
          });
        });
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        menu.addItem((item) => {
          item.setTitle("Envoyer dans note rapide").setIcon("send").onClick(async () => {
            await this.sendToQuickNote(file);
          });
        });
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file || file.extension !== "md") return;
        if (this.currentStatus === "connected") return;
        const cache = this.app.metadataCache.getFileCache(file);
        const idNote = cache?.frontmatter?.["IdNote"];
        if (!idNote) return;
        this.showDisconnectedModal();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        if (!(file instanceof import_obsidian4.TFile) || file.extension !== "md") return;
        const serverInitiated = this.wsClient?.updatingFiles.includes(file.path) ?? false;
        window.setTimeout(async () => {
          if (!serverInitiated) {
            await this.handleFileModified(file);
          }
          const resolvedLinks = this.app.metadataCache.resolvedLinks;
          for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
            if (!(file.path in targets)) continue;
            const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
            if (!(sourceFile instanceof import_obsidian4.TFile)) continue;
            const cache = this.app.metadataCache.getFileCache(sourceFile);
            if (!cache?.frontmatter?.["IdNote"]) continue;
            await this.handleFileModified(sourceFile);
          }
        }, 500);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof import_obsidian4.TFile) || file.extension !== "md") return;
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.path !== file.path) return;
        if (this.wsClient?.updatingFiles.includes(file.path)) return;
        if (this.activeFileTimer !== null) window.clearTimeout(this.activeFileTimer);
        this.activeFileTimer = window.setTimeout(async () => {
          this.activeFileTimer = null;
          await this.handleFileModified(file);
        }, 1e3);
      })
    );
    this.addCommand({
      id: "create-quick-note",
      name: "Cr\xE9er une note rapide",
      callback: async () => {
        await this.createQuickNote();
      }
    });
    this.addCommand({
      id: "connect-websocket",
      name: "Connect WebSocket",
      callback: async () => {
        await this.startWebSocket();
        new import_obsidian4.Notice("WebSocket connect\xE9");
      }
    });
    this.addCommand({
      id: "disconnect-websocket",
      name: "Disconnect WebSocket",
      callback: async () => {
        await this.stopWebSocket();
        new import_obsidian4.Notice("WebSocket d\xE9connect\xE9");
      }
    });
    if (this.settings.autoConnect) {
      await this.startWebSocket();
    }
  }
  async onunload() {
    if (this.activeFileTimer !== null) window.clearTimeout(this.activeFileTimer);
    await this.stopWebSocket();
  }
  async setFrontmatterProperty(file, key, value) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[key] = value;
    });
  }
  async sendToQuickNote(target) {
    try {
      if (!(target instanceof import_obsidian4.TFile)) return;
      if (!this.wsClient) {
        throw new Error("WebSocket non initialis\xE9");
      }
      const idNote = await this.wsClient.getNoteId();
      await this.setFrontmatterProperty(target, "IdNote", idNote);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new import_obsidian4.Notice(`Impossible de synchroniser la note rapide : ${message}`, 8e3);
      console.error("[GTCSyncPlugin] sendToQuickNote error:", error);
    }
  }
  async createQuickNote(target) {
    try {
      if (!this.wsClient) {
        throw new Error("WebSocket non initialis\xE9");
      }
      const idNote = await this.wsClient.getNoteId();
      const folderPath = this.resolveQuickNoteFolder(target);
      const fileName = this.buildQuickNoteFileName();
      const fullPath = (0, import_obsidian4.normalizePath)(`${folderPath}/${fileName}`);
      const content = ["---", `IdNote: ${idNote}`, "---", ""].join("\n");
      this.wsClient.updatingFiles.push(fullPath);
      window.setTimeout(() => {
        this.wsClient?.updatingFiles.remove(fullPath);
      }, 2e3);
      const createdFile = await this.app.vault.create(fullPath, content);
      new import_obsidian4.Notice(`Note rapide cr\xE9\xE9e : ${createdFile.path}`);
      await this.app.workspace.getLeaf(true).openFile(createdFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new import_obsidian4.Notice(`Impossible de cr\xE9er la note rapide : ${message}`, 8e3);
      console.error("[GTCSyncPlugin] createQuickNote error:", error);
    }
  }
  resolveQuickNoteFolder(target) {
    if (target instanceof import_obsidian4.TFolder) return target.path;
    if (target instanceof import_obsidian4.TFile) return target.parent?.path ?? "";
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile instanceof import_obsidian4.TFile) return activeFile.parent?.path ?? "";
    return "";
  }
  buildQuickNoteFileName() {
    const now = /* @__PURE__ */ new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `Quick Note ${yyyy}-${mm}-${dd} ${hh}-${mi}-${ss}.md`;
  }
  async restartWebSocket() {
    await this.stopWebSocket();
    await this.startWebSocket();
  }
  async handleFileModified(file) {
    try {
      if (!(file instanceof import_obsidian4.TFile) || file.extension !== "md") return;
      const cache = this.app.metadataCache.getFileCache(file);
      const IdNote = cache?.frontmatter?.["IdNote"];
      if (!IdNote) return;
      if (this.currentStatus !== "connected") {
        this.showDisconnectedModal();
        return;
      }
      const content = await this.app.vault.read(file);
      this.debugLog("note.saved \u2192", file.path);
      const response = await this.wsClient?.saveNote({
        path: file.path,
        IdNote,
        contentLines: content.split("\n"),
        metadata: {
          createdAt: new Date(file.stat.ctime).toISOString(),
          modifiedAt: new Date(file.stat.mtime).toISOString(),
          createdAtMs: file.stat.ctime,
          modifiedAtMs: file.stat.mtime
        }
      });
      this.debugLog("note.saved \u2190", response);
      if (typeof response !== "object" || response === null) {
        throw new Error("R\xE9ponse invalide pour note.saved");
      }
      const result = response.result;
      if (typeof result !== "object" || result === null) {
        throw new Error("R\xE9sultat invalide pour note.saved");
      }
      const resultObj = result;
      if (resultObj.Type === "Error") {
        if (String(resultObj.Code) === "74") {
          new AlertModal(
            this.app,
            "GTC-Sync : Attention",
            "La note est r\xE9serv\xE9e par un autre utilisateur,\nles modifications peuvent \xEAtre perdues !"
          ).open();
        } else {
          new AlertModal(
            this.app,
            "GTC-Sync : Attention",
            "Erreur " + String(resultObj.Code) + " : " + String(resultObj.Message ?? "")
          ).open();
        }
        return;
      }
      new import_obsidian4.Notice("La note a \xE9t\xE9 synchronis\xE9e.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new import_obsidian4.Notice(`GTC-Sync : \xE9chec de la synchronisation \u2014 ${message}`, 8e3);
      console.error("[GTCSyncPlugin] Erreur handleFileModified:", error);
    }
  }
  async startWebSocket() {
    if (this.wsClient) {
      await this.wsClient.stop();
      this.wsClient = null;
    }
    this.wsClient = new WebSocketClient(
      this.vaultApi,
      this.settings.websocketUrl,
      this.app,
      this.settings.websocketToken || void 0,
      (status) => this.setConnectionStatus(status),
      () => this.onSessionReplaced(),
      (...args) => this.debugLog(...args)
    );
    await this.wsClient.start();
  }
  async stopWebSocket() {
    if (this.wsClient) {
      await this.wsClient.stop();
      this.wsClient = null;
    }
  }
  async loadSettings() {
    const localData = this.app.loadLocalStorage(LOCAL_SETTINGS_KEY);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, localData ?? {});
  }
  async saveSettings() {
    this.app.saveLocalStorage(LOCAL_SETTINGS_KEY, this.settings);
  }
};
var GTCSyncPluginSettingTab = class extends import_obsidian4.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian4.Setting(containerEl).setName("WebSocket URL").setDesc("Adresse du serveur WebSocket").addText(
      (text) => text.setPlaceholder("ws://127.0.0.1:8080").setValue(this.plugin.settings.websocketUrl).onChange(async (value) => {
        this.plugin.settings.websocketUrl = value;
        await this.plugin.saveSettings();
        await this.plugin.restartWebSocket();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("WebSocket token").setDesc("Token envoy\xE9 au serveur apr\xE8s connexion").addText(
      (text) => text.setPlaceholder("token").setValue(this.plugin.settings.websocketToken).onChange(async (value) => {
        this.plugin.settings.websocketToken = value;
        await this.plugin.saveSettings();
        await this.plugin.restartWebSocket();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Auto connect").setDesc("Se reconnecter automatiquement au chargement du plugin").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoConnect).onChange(async (value) => {
        this.plugin.settings.autoConnect = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Mode debug").setDesc("Affiche les logs d\xE9taill\xE9s dans la console du d\xE9veloppeur (F12)").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.debug).onChange(async (value) => {
        this.plugin.settings.debug = value;
        await this.plugin.saveSettings();
      })
    );
  }
};

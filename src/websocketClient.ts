import { VaultApi } from "./vaultApi";
import { CommandRequest, CommandResponse } from "./types";
import { Notice, App } from "obsidian";
import { AlertModal } from "./alertModal";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "auth-error";

export class WebSocketClient {

  private ws: WebSocket | null = null;
  private running = false;
  private reconnectTimer: number | null = null;
  private sessionReplaced = false;

  // Chemins des fichiers modifiés par une commande distante en cours.
  // Permet d'ignorer l'event vault "modify" qu'elles génèrent et d'éviter une boucle de sync.
  public updatingFiles: string[] = [];

  // Requêtes plugin → serveur en attente de réponse, indexées par UUID.
  // Chaque entrée est résolue ou rejetée à réception du message correspondant (même id).
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      timeout: number;
    }
  >();

  constructor(
    private vaultApi: VaultApi,
    private url: string,
    private app: App,
    private token?: string,
    private onStatusChange?: (status: ConnectionStatus) => void,
    private onSessionReplaced?: () => void,
    private debugLog?: (...args: unknown[]) => void,
  ) { }

  async start(): Promise<void> {
    this.running = true;
    this.sessionReplaced = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPendingRequests("WebSocket fermé");
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    this.debugLog?.("connexion à", this.url);
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

    ws.onmessage = async (event: MessageEvent) => {
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        const parsed = JSON.parse(raw);
        this.debugLog?.("↓", parsed);

        if (parsed.type === "auth.ok") {
          this.debugLog?.("authentification OK");
          this.onStatusChange?.("connected");
          return;
        }

        if (parsed.type === "auth.error") {
          console.error("[WS] authentification échouée:", parsed.error);
          this.onStatusChange?.("auth-error");
          return;
        }

        if (parsed.type === "session.replaced") {
          console.warn("[WS] session remplacée par une autre connexion");
          this.sessionReplaced = true;
          this.running = false;
          return;
        }

        // Réponse à une requête initiée par le plugin (pattern request/response via id).
        if (typeof parsed.id === "string" && this.pendingRequests.has(parsed.id)) {
          const pending = this.pendingRequests.get(parsed.id)!;
          window.clearTimeout(pending.timeout);
          this.pendingRequests.delete(parsed.id);

          if (parsed.ok === false) {
            pending.reject(new Error(typeof parsed.error === "string" ? parsed.error : "Erreur inconnue"));
            return;
          }

          pending.resolve(parsed);
          return;
        }

        // Commande entrante initiée par le serveur.
        const command = this.parseCommand(parsed);
        const response = await this.executeCommand(command);
        this.debugLog?.("↑", response);
        ws.send(JSON.stringify(response));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`GTC-Sync : erreur de traitement du message — ${message}`, 8000);
        ws.send(JSON.stringify({ id: "unknown", ok: false, error: message }));
      }
    };

    ws.onerror = () => {
      console.error("[WS] erreur websocket");
    };

    ws.onclose = () => {
      console.warn("[WS] connexion fermée");
      this.rejectPendingRequests("Connexion WebSocket fermée");
      if (this.sessionReplaced) {
        this.onStatusChange?.("disconnected");
        this.onSessionReplaced?.();
        return;
      }
      this.onStatusChange?.("disconnected");
      if (this.running) {
        this.debugLog?.("reconnexion dans 3 s");
        this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
      }
    };
  }

  private rejectPendingRequests(reason: string): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }

  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  public async saveNote(payload: {
    path: string;
    IdNote: string;
    contentLines: string[];
    metadata: {
      createdAt: string;
      modifiedAt: string;
      createdAtMs: number;
      modifiedAtMs: number;
    };
  }): Promise<unknown> {
    return this.request("note.saved", payload as unknown as Record<string, unknown>);
  }

  public async getNoteId(): Promise<string> {
    const response = await this.request("note.getId");

    if (typeof response !== "object" || response === null) {
      throw new Error("Réponse invalide pour note.getId");
    }

    const result = (response as Record<string, unknown>).result;
    if (typeof result !== "object" || result === null) {
      throw new Error("Résultat invalide pour note.getId");
    }

    const idNote = (result as Record<string, unknown>).idNote;
    if (typeof idNote !== "string" || !idNote.trim()) {
      throw new Error("idNote manquant dans la réponse");
    }

    return idNote;
  }

  public async request(type: string, payload?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket non connecté");
    }

    const id = this.generateRequestId();

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout en attente de réponse pour ${type}`));
      }, 10000);

      const message = { id, type, ...(payload ?? {}) };
      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.debugLog?.("↑", message);
      this.ws!.send(JSON.stringify(message));
    });
  }

  private parseCommand(value: unknown): CommandRequest {
    if (typeof value !== "object" || value === null) {
      throw new Error("Message invalide: objet attendu");
    }

    const obj = value as Record<string, unknown>;

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

  private async executeCommand(command: CommandRequest): Promise<CommandResponse> {
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
          window.setTimeout(() => this.updatingFiles.remove(command.path), 3000);
          const result = await this.vaultApi.createNote(command.path, command.content);
          return { id: command.id, ok: true, result };
        }

        case "note.move": {
          this.updatingFiles.push(command.newPath);
          window.setTimeout(() => this.updatingFiles.remove(command.newPath), 3000);
          const result = await this.vaultApi.moveNote(command.path, command.newPath);
          return { id: command.id, ok: true, result };
        }

        case "note.replace": {
          this.updatingFiles.push(command.path);
          window.setTimeout(() => this.updatingFiles.remove(command.path), 3000);
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
      new Notice(`GTC-Sync : échec de ${command.type} — ${message}`, 8000);
      return { id: command.id, ok: false, error: message };
    }
  }
}

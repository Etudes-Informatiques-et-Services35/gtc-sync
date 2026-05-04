import { App, Modal, setIcon } from "obsidian";

export class AlertModal extends Modal {
  private static nbinstances: number = 0;
  constructor(
    app: App,
    private title: string,
    private message: string,
    private variant: "warning" | "error" = "warning",
    private action?: { label: string; onClick: () => void },
    private onCloseCallback?: () => void,
  ) {
    super(app);
    AlertModal.nbinstances += 1;
  }
  destroy() {
    AlertModal.nbinstances -= 1;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;

    titleEl.setText(this.title);

    contentEl.empty();
    contentEl.addClass("gtc-alert");
    contentEl.addClass(`gtc-alert--${this.variant}`);

    const body = contentEl.createDiv({ cls: "gtc-alert__body" });

    const iconEl = body.createDiv({ cls: "gtc-alert__icon" });
    setIcon(iconEl, this.variant === "error" ? "alert-circle" : "alert-triangle");

    body.createDiv({
      cls: "gtc-alert__message",
      text: this.message,
    });

    const buttonRow = contentEl.createDiv({ cls: "gtc-alert__buttons" });

    if (this.action) {
      const action = this.action;
      const actionButton = buttonRow.createEl("button", {
        text: action.label,
        cls: "mod-cta",
      });
      actionButton.addEventListener("click", () => {
        this.close();
        action.onClick();
      });
    }

    const okButton = buttonRow.createEl("button", { text: "OK" });
    okButton.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
    this.onCloseCallback?.();
  }
}
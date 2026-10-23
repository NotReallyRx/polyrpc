import { PolyMod } from "https://cdn.polymodloader.com/cb/polytrackmods/PolyModLoader/0.6.3/PolyTypes.js";
import { sendRpcRequest } from "./rpc.js";

class PolyRpcMod extends PolyMod {
  rpc = null;
  connecting = false;
  token = "";
  toggleBtn = null;
  stateTimer = null;

  init = (pml) => {
    this.pml = pml;

    pml.registerSettingCategory("PolyRPC");
    pml.addCustomClickableButtons("Quick actions", [
      {
        text: "Set Discord Token",
        callback: () => this.setToken(),
      },
    ]);
    pml.addCustomClickableButtons("Discord Rich Presence", [
      {
        text: "Toggle Discord RPC",
        callback: () => this.toggle(),
      },
    ]);

    this.updateToggleLabel();
    this.startStateUpdater();
  };

  setToken = async () => {
    const token = await this.askToken();
    if (!token) {
      return;
    }
    const trimmed = String(token).trim();
    if (!trimmed) {
      alert("Token not set.");
      return;
    }
    if (/\s/.test(trimmed)) {
      alert("Token must not contain whitespace.");
      return;
    }
    this.token = trimmed;
    alert("Token set in memory.");
  };

  askToken = () => {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);font-family:Arial,sans-serif;";

      const form = document.createElement("form");
      form.style.cssText =
        "display:flex;flex-direction:column;gap:14px;width:min(420px,calc(100vw - 40px));padding:22px;border-radius:12px;background:#1c1c1c;color:#fff;box-shadow:0 20px 60px rgba(0,0,0,.5);";

      const title = document.createElement("h2");
      title.textContent = "Discord RPC";
      title.style.cssText = "margin:0;font-size:20px;";

      const label = document.createElement("label");
      label.textContent = "Discord user token";
      label.style.cssText =
        "display:flex;flex-direction:column;gap:6px;font-size:13px;color:#bbb;";

      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "Paste your user token";
      input.style.cssText =
        "padding:10px 12px;border:1px solid #3a3a3a;border-radius:8px;background:#101010;color:#fff;font:inherit;outline:none;";
      label.appendChild(input);

      const note = document.createElement("p");
      note.textContent = "The token stays in memory and is never stored by this mod.";
      note.style.cssText = "margin:0;font-size:12px;line-height:1.5;color:#888;";

      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.style.cssText =
        "padding:9px 14px;border:1px solid #3a3a3a;border-radius:8px;background:transparent;color:#bbb;font:inherit;cursor:pointer;";

      const submit = document.createElement("button");
      submit.type = "submit";
      submit.textContent = "Set";
      submit.style.cssText =
        "padding:9px 14px;border:0;border-radius:8px;background:#5865f2;color:#fff;font:inherit;font-weight:bold;cursor:pointer;";

      row.appendChild(cancel);
      row.appendChild(submit);
      form.appendChild(title);
      form.appendChild(label);
      form.appendChild(note);
      form.appendChild(row);
      overlay.appendChild(form);

      const finish = (value) => {
        document.removeEventListener("keydown", onKeyDown);
        input.value = "";
        overlay.remove();
        resolve(value);
      };

      const onKeyDown = (event) => {
        if (event.key === "Escape") finish("");
      };

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        finish(input.value);
      });

      cancel.addEventListener("click", () => finish(""));
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish("");
      });
      document.addEventListener("keydown", onKeyDown);

      document.body.appendChild(overlay);
      input.focus();
    });
  };

  updateToggleLabel = () => {
    const btns = Array.from(document.querySelectorAll("button"));
    for (const btn of btns) {
      if (btn.textContent && btn.textContent.trim() === "Toggle Discord RPC") {
        this.toggleBtn = btn;
        break;
      }
    }
    if (this.toggleBtn) {
      this.toggleBtn.textContent = this.rpc?.connected ? "Disconnect Discord RPC" : "Connect Discord RPC";
    }
  };

  toggle = async () => {
    if (this.rpc?.connected) {
      this.disconnect();
      return;
    }
    await this.connect();
  };

  connect = async () => {
    if (this.connecting) return;
    if (this.rpc?.connected) {
      alert("Discord RPC is already connected.");
      this.updateToggleLabel();
      return;
    }
    if (!this.token) {
      alert("Set a Discord token first via Quick actions > Set Discord Token.");
      return;
    }

    this.connecting = true;
    try {
      if (this.rpc) this.rpc.close();

      const state = this.getScreenState();
      this.rpc = await sendRpcRequest({
        id: this.token,
        client: "polymodloader",
        version: "0.6.3",
        state: state,
      });

      alert("Discord RPC connected.");
    } catch (error) {
      this.rpc = null;
      alert(`Discord RPC failed: ${error.message}`);
    } finally {
      this.connecting = false;
      this.updateToggleLabel();
    }
  };

  disconnect = () => {
    if (!this.rpc) {
      alert("Discord RPC is not connected.");
      this.updateToggleLabel();
      return;
    }

    this.rpc.close();
    this.rpc = null;
    alert("Discord RPC disconnected.");
    this.updateToggleLabel();
  };

  isHidden = (el) => {
    if (!el) return true;
    if (el.classList.contains("hidden")) return true;
    const style = getComputedStyle(el);
    if (style.display === "none") return true;
    return false;
  };

  getScreenState = () => {
    try {
      const gameUi = document.querySelector(".game-ui");
      if (gameUi && !this.isHidden(gameUi)) {
        const gameToolbar = document.querySelector(".game-toolbar-ui");
        if (gameToolbar && !this.isHidden(gameToolbar)) {
          const trackNameEl = gameToolbar.querySelector(".track-name");
          const trackName = trackNameEl && trackNameEl.textContent ? trackNameEl.textContent.trim() : "";
          if (trackName) return `Playing: ${trackName}`;
        }
        const timeAnnouncer = document.querySelector(".time-announcer-ui");
        if (timeAnnouncer && !this.isHidden(timeAnnouncer)) {
          const trackNameEl = timeAnnouncer.querySelector(".track-name");
          const trackName = trackNameEl && trackNameEl.textContent ? trackNameEl.textContent.trim() : "";
          if (trackName) return `Playing: ${trackName}`;
        }
        return "Playing";
      }

      const editorUi = document.querySelector(".editor-ui");
      if (editorUi && !this.isHidden(editorUi)) {
        const trackSettingsBtn = editorUi.querySelector(".track-settings-container > button");
        const trackName = trackSettingsBtn && trackSettingsBtn.textContent ? trackSettingsBtn.textContent.trim() : "";
        if (trackName) return `Editing: ${trackName}`;
        return "Editing";
      }

      const trackExportUi = document.querySelector(".track-export-ui");
      if (trackExportUi && !this.isHidden(trackExportUi)) {
        const importBtn = trackExportUi.querySelector(".button.right");
        if (importBtn && importBtn.textContent && importBtn.textContent.includes("Import")) {
          return "Importing";
        }
        return "Exporting";
      }

      const trackInfoUi = document.querySelector(".track-info-ui");
      if (trackInfoUi && !this.isHidden(trackInfoUi)) {
        return "Track Info";
      }

      const trackSelectionUi = document.querySelector(".track-selection-ui");
      if (trackSelectionUi && !this.isHidden(trackSelectionUi)) {
        return "Track Selection";
      }

      const settingsMenuUi = document.querySelector(".settings-menu-ui");
      if (settingsMenuUi && !this.isHidden(settingsMenuUi)) {
        return "Settings";
      }

      const menuUi = document.querySelector(".menu-ui");
      if (menuUi && !this.isHidden(menuUi)) {
        return "Main Menu";
      }

      return "Idle";
    } catch (e) {
      return "Idle";
    }
  };

  startStateUpdater = () => {
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.stateTimer = setInterval(() => {
      this.updateToggleLabel();
      if (this.rpc?.connected) {
        try {
          const state = this.getScreenState();
          this.rpc.update({ state: state, client: "polymodloader", version: "0.6.3" });
        } catch (e) {
          // ignore
        }
      }
    }, 1500);
  };
}

export const polyMod = new PolyRpcMod();

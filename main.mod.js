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

  setToken = () => {
    const value = prompt("Discord user token (not stored):");
    if (value === null) return;
    const token = String(value).trim();
    if (!token) {
      alert("Token not set.");
      return;
    }
    if (/\s/.test(token)) {
      alert("Token must not contain whitespace.");
      return;
    }
    this.token = token;
    alert("Token set in memory.");
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

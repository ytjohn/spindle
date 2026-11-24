import type {
  ExtensionUIContext,
  ExtensionCommandContextActions,
} from "@earendil-works/pi-coding-agent";

/**
 * Shape of the things the Telegram channel needs to provide to the UI
 * context: a way to emit text back to the user's chat, and (eventually)
 * interactive dialog handlers for confirm/select/input.
 *
 * For Phase 3.1 only `notify` is wired — the dialog methods are stubbed
 * to throw. Extension commands that only call notify() will work; those
 * that need interactive dialogs will fail loudly until we add Telegram
 * inline keyboard support.
 */
export interface TelegramUIAdapter {
  notify: (message: string, type?: "info" | "warning" | "error") => void;
}

function unsupported(method: string): never {
  throw new Error(
    `[spindle] Telegram channel does not yet support extension UI method '${method}'. ` +
      `The extension command tried to open an interactive dialog.`
  );
}

/**
 * Build an `ExtensionUIContext` pi-agent can inject into extension
 * command handlers. Routes `notify` to Telegram via the adapter;
 * stubs TTY-only methods as no-ops or throws. Shape mirrors TelePi's
 * `createTelegramUIContext` in src/telegram-ui-context.ts.
 */
export function createTelegramUIContext(adapter: TelegramUIAdapter): ExtensionUIContext {
  return {
    async select(_title, _choices, _dialogOptions) {
      unsupported("select");
    },
    async confirm(_title, _message, _dialogOptions) {
      unsupported("confirm");
    },
    async input(_title, _placeholder, _dialogOptions) {
      unsupported("input");
    },
    notify(message, type) {
      adapter.notify(message, type);
    },
    onTerminalInput() {
      return () => {};
    },
    setStatus() {},
    setWorkingMessage() {},
    setWorkingIndicator() {},
    // pi 0.84 additions. Both are TTY affordances with no Telegram
    // equivalent, so they follow the existing no-op / undefined pattern
    // rather than unsupported(): an extension toggling a spinner or
    // asking whether a rich editor exists should degrade quietly, not
    // abort the command.
    setWorkingVisible() {},
    getEditorComponent() {
      return undefined;
    },
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    async custom() {
      unsupported("custom");
    },
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return "";
    },
    async editor() {
      unsupported("editor");
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    // Theme / tools are TTY-only visual state. Return safe defaults so
    // extensions querying them don't crash.
    // theme.fg/bg/bold etc. must return the plain text so extensions that
    // call ctx.ui.theme.fg("accent", text) don't crash with "not a function".
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      dim: (text: string) => text,
      italic: (text: string) => text,
      underline: (text: string) => text,
      strikethrough: (text: string) => text,
      getFgAnsi: (_color: string) => "",
      getBgAnsi: (_color: string) => "",
    } as never,
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return {
        success: false,
        error: "[spindle] Telegram channel does not support theme switching.",
      };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };
}

/**
 * Placeholder `ExtensionCommandContextActions` for Phase 3.1.
 *
 * Most extension commands never touch these (session management,
 * forking, tree navigation). The ones that do — e.g. a Telegram `/new`
 * handler that wants to start a fresh session — will hit the stubs and
 * get a clear "not implemented" rejection rather than silent breakage.
 *
 * Later phases wire these to real channel/session operations.
 */
export function createStubCommandContextActions(): ExtensionCommandContextActions {
  const cancelled = async () => ({ cancelled: true as const });
  return {
    waitForIdle: async () => {
      // We deliberately don't block here. The channel's event-driven
      // busy/idle tracking handles turn completion — a command handler
      // calling waitForIdle during a live prompt would deadlock us.
    },
    newSession: cancelled,
    fork: cancelled,
    navigateTree: cancelled,
    switchSession: cancelled,
    reload: async () => {},
  };
}

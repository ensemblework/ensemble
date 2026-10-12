"use client";

/** The small part of the Google Picker API Ensemble uses. */
type PickerDoc = { id: string; name?: string };
type PickerData = { action: string; docs?: PickerDoc[] };
type PickerBuilder = {
  addView: (view: unknown) => PickerBuilder;
  enableFeature: (feature: unknown) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setAppId: (id: string) => PickerBuilder;
  setOrigin: (origin: string) => PickerBuilder;
  setTitle: (title: string) => PickerBuilder;
  setCallback: (callback: (data: PickerData) => void) => PickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
};
type PickerNamespace = {
  DocsView: new (viewId?: unknown) => { setIncludeFolders: (value: boolean) => unknown; setSelectFolderEnabled: (value: boolean) => unknown };
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS: unknown };
  Feature: { MULTISELECT_ENABLED: unknown };
  Action: { PICKED: string; CANCEL: string };
};
type GoogleWindow = Window & {
  gapi?: { load: (name: string, options: { callback: () => void; onerror?: () => void; timeout?: number; ontimeout?: () => void }) => void };
  google?: { picker?: PickerNamespace };
};

const SCRIPT = "https://apis.google.com/js/api.js";
let loading: Promise<PickerNamespace> | null = null;

function loadPicker(): Promise<PickerNamespace> {
  loading ??= new Promise<PickerNamespace>((resolve, reject) => {
    const win = window as GoogleWindow;
    const ready = () =>
      win.gapi!.load("picker", {
        callback: () => (win.google?.picker ? resolve(win.google.picker) : reject(new Error("no picker"))),
        onerror: () => reject(new Error("picker failed")),
        timeout: 15_000,
        ontimeout: () => reject(new Error("picker timed out")),
      });
    if (win.gapi) {
      ready();
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = ready;
    script.onerror = () => reject(new Error("script failed"));
    document.head.appendChild(script);
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

export const PICKER_UNAVAILABLE = "Google Drive's file picker could not load. Check your internet connection and try again, or use Choose files instead.";

/** Opens Google's own file picker over the page. Resolves with the picked file ids, or none when closed. */
export async function pickFromGoogleDrive(config: { apiKey: string; appId: string; accessToken: string; origin: string }): Promise<string[]> {
  let picker: PickerNamespace;
  try {
    picker = await loadPicker();
  } catch {
    throw new Error(PICKER_UNAVAILABLE);
  }
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS);
    view.setIncludeFolders(true);
    view.setSelectFolderEnabled(false);
    new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setTitle("Add files from Google Drive")
      .setOAuthToken(config.accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setOrigin(config.origin)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) resolve((data.docs ?? []).map((doc) => doc.id));
        else if (data.action === picker.Action.CANCEL) resolve([]);
      })
      .build()
      .setVisible(true);
  });
}

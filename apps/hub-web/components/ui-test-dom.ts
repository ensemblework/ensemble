import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

const domWindow = dom.window;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

setGlobal("window", domWindow);
setGlobal("document", domWindow.document);
setGlobal("navigator", domWindow.navigator);
setGlobal("HTMLElement", domWindow.HTMLElement);
setGlobal("HTMLInputElement", domWindow.HTMLInputElement);
setGlobal("HTMLButtonElement", domWindow.HTMLButtonElement);
setGlobal("HTMLTextAreaElement", domWindow.HTMLTextAreaElement);
setGlobal("HTMLSelectElement", domWindow.HTMLSelectElement);
setGlobal("Element", domWindow.Element);
setGlobal("Node", domWindow.Node);
setGlobal("DocumentFragment", domWindow.DocumentFragment);
setGlobal("Event", domWindow.Event);
setGlobal("KeyboardEvent", domWindow.KeyboardEvent);
setGlobal("MouseEvent", domWindow.MouseEvent);
setGlobal("InputEvent", domWindow.InputEvent);
setGlobal("SVGElement", domWindow.SVGElement);
setGlobal("MutationObserver", domWindow.MutationObserver);
setGlobal("getComputedStyle", domWindow.getComputedStyle.bind(domWindow));
setGlobal("requestAnimationFrame", domWindow.requestAnimationFrame.bind(domWindow));
setGlobal("cancelAnimationFrame", domWindow.cancelAnimationFrame.bind(domWindow));
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

/** Moves the test page to another address (jsdom cannot navigate across origins by itself). */
export function setTestUrl(url: string): void {
  dom.reconfigure({ url });
}

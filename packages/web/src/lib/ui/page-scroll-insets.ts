type PageTopInsetListener = () => void;

const pageTopInsets = new Set<HTMLElement>();
const pageTopInsetListeners = new Set<PageTopInsetListener>();

function notifyPageTopInsetListeners() {
  for (const listener of pageTopInsetListeners) listener();
}

export function registerPageTopInset(element: HTMLElement) {
  pageTopInsets.add(element);
  notifyPageTopInsetListeners();

  return () => {
    if (!pageTopInsets.delete(element)) return;
    notifyPageTopInsetListeners();
  };
}

export function getPageTopInsets(): ReadonlySet<HTMLElement> {
  return pageTopInsets;
}

export function subscribePageTopInsets(listener: PageTopInsetListener) {
  pageTopInsetListeners.add(listener);
  return () => {
    pageTopInsetListeners.delete(listener);
  };
}

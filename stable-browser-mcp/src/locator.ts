import type { Locator, Page } from 'playwright';

export type LocatorKind = 'css' | 'text' | 'role' | 'label' | 'placeholder' | 'testid';

export type LocatorSpec = {
  selector: string;
  by?: LocatorKind;
  name?: string;
  exact?: boolean;
};

export function resolveLocator(page: Page, spec: LocatorSpec): Locator {
  const by = spec.by ?? 'css';
  const exact = spec.exact ?? false;

  switch (by) {
    case 'text':
      return page.getByText(spec.selector, { exact });
    case 'label':
      return page.getByLabel(spec.selector, { exact });
    case 'placeholder':
      return page.getByPlaceholder(spec.selector, { exact });
    case 'testid':
      return page.getByTestId(spec.selector);
    case 'role':
      return page.getByRole(spec.selector as never, {
        name: spec.name,
        exact
      });
    case 'css':
    default:
      return page.locator(spec.selector);
  }
}

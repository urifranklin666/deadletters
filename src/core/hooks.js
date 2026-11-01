/**
 * Deadletters Hooks & Filters System
 * Complete drop-in architecture matching WordPress add_action / add_filter / do_action / apply_filters
 * Powers all Deadletters addons, themes, and lifecycle overrides.
 */

class HookEngine {
  constructor() {
    this.actions = new Map();
    this.filters = new Map();
  }

  addAction(hookName, callback, priority = 10, addonSlug = 'core') {
    if (!this.actions.has(hookName)) {
      this.actions.set(hookName, []);
    }
    this.actions.get(hookName).push({ callback, priority, addonSlug });
    this.actions.get(hookName).sort((a, b) => a.priority - b.priority);
  }

  doAction(hookName, ...args) {
    if (!this.actions.has(hookName)) return;
    const listeners = this.actions.get(hookName);
    for (const listener of listeners) {
      try {
        listener.callback(...args);
      } catch (err) {
        console.error(`[Hooks Engine] Action error in "${hookName}" from "${listener.addonSlug}":`, err);
      }
    }
  }

  addFilter(hookName, callback, priority = 10, addonSlug = 'core') {
    if (!this.filters.has(hookName)) {
      this.filters.set(hookName, []);
    }
    this.filters.get(hookName).push({ callback, priority, addonSlug });
    this.filters.get(hookName).sort((a, b) => a.priority - b.priority);
  }

  applyFilters(hookName, initialValue, ...args) {
    if (!this.filters.has(hookName)) return initialValue;
    const listeners = this.filters.get(hookName);
    let value = initialValue;
    for (const listener of listeners) {
      try {
        value = listener.callback(value, ...args);
      } catch (err) {
        console.error(`[Hooks Engine] Filter error in "${hookName}" from "${listener.addonSlug}":`, err);
      }
    }
    return value;
  }

  removeAction(hookName, callback) {
    if (!this.actions.has(hookName)) return;
    const filtered = this.actions.get(hookName).filter(item => item.callback !== callback);
    this.actions.set(hookName, filtered);
  }

  removeFilter(hookName, callback) {
    if (!this.filters.has(hookName)) return;
    const filtered = this.filters.get(hookName).filter(item => item.callback !== callback);
    this.filters.set(hookName, filtered);
  }

  getIntrospection() {
    const actionList = [];
    for (const [hook, items] of this.actions.entries()) {
      actionList.push({
        hook,
        type: 'action',
        handlers: items.map(i => ({ priority: i.priority, addon: i.addonSlug }))
      });
    }
    const filterList = [];
    for (const [hook, items] of this.filters.entries()) {
      filterList.push({
        hook,
        type: 'filter',
        handlers: items.map(i => ({ priority: i.priority, addon: i.addonSlug }))
      });
    }
    return { actions: actionList, filters: filterList };
  }
}

const hooks = new HookEngine();
module.exports = hooks;

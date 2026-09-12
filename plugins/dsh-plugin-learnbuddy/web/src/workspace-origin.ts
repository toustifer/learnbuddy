export function canUseConfiguredWorkspace(config: { publicOrigin?: unknown } | undefined, page: { hostname: string; origin: string }): boolean {
  return ["127.0.0.1", "localhost"].includes(page.hostname) ||
    (typeof config?.publicOrigin === "string" && config.publicOrigin === page.origin);
}

import { createContext, useContext } from "react";
import type { DemoState, Route, User } from "./types";

interface Store {
  state: DemoState;
  user: User | null;
  route: Route;
  courseId: string;
  busy: Record<string, boolean>;
  update: (fn: (s: DemoState) => DemoState) => void;
  login: (u: User) => void;
  logout: () => void;
  go: (r: Route) => void;
  setCourseId: (id: string) => void;
  notify: (message: string, error?: boolean) => void;
  job: (key: string, action: () => void | Promise<void>) => Promise<void>;
  gradeReports: (ids: string[]) => Promise<void>;
  reset: () => Promise<void>;
}
export const Context = createContext<Store | null>(null);
export function useStore() {
  const value = useContext(Context);
  if (!value) throw new Error("Missing store");
  return value;
}

import { createContext, useContext } from "react";
import type { DemoState, Route, User, ServerReview } from "./types";

interface Store {
  state: DemoState;
  reviewResults: Record<string, ServerReview>;
  updateReviewResults: (
    fn: (current: Record<string, ServerReview>) => Record<string, ServerReview>,
  ) => void;
  user: User | null;
  route: Route;
  courseId: string;
  busy: Record<string, boolean>;
  update: (fn: (s: DemoState) => DemoState) => void;
  login: (username: string, password: string) => Promise<void>;
  materialsLoading: boolean;
  materialsError: string;
  refreshMaterials: () => Promise<void>;
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

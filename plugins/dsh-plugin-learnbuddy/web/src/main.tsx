import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { Theme } from "@radix-ui/themes";
import { MotionConfig } from "motion/react";
import "@radix-ui/themes/styles.css";
import { installRandomUUIDPolyfill } from "./lib/random-id";
import "./styles.css";
import "./workspace.css";
import "./product.css";

// 非安全上下文（HTTP + 非 localhost）没有 crypto.randomUUID，渲染期调用会抛
// TypeError 并被 ErrorBoundary 兜底。挂载 React 之前幂等补齐；原生可用时不改动。
installRandomUUIDPolyfill();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Theme accentColor="jade" grayColor="slate" radius="large" scaling="100%" appearance="light">
        <MotionConfig reducedMotion="user"><App /></MotionConfig>
      </Theme>
    </ErrorBoundary>
  </React.StrictMode>,
);

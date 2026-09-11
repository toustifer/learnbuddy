import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { Theme } from "@radix-ui/themes";
import { MotionConfig } from "motion/react";
import "@radix-ui/themes/styles.css";
import "./styles.css";
import "./workspace.css";
import "./product.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Theme accentColor="jade" grayColor="slate" radius="large" scaling="100%" appearance="light">
        <MotionConfig reducedMotion="user"><App /></MotionConfig>
      </Theme>
    </ErrorBoundary>
  </React.StrictMode>,
);

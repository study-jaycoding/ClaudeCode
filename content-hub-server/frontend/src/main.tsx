import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AssetsWindow } from "./components/AssetsWindow";
import "./styles.css";

// `/?embed=assets` 로 열면 Assets 만 독립 창으로 렌더(분리된 브라우저 창).
const embed = new URLSearchParams(window.location.search).get("embed");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{embed === "assets" ? <AssetsWindow /> : <App />}</StrictMode>,
);

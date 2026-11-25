import { createRoot, hydrateRoot } from "react-dom/client";

import "../../client/src/app.css";
import { App } from "./app";

const root = document.querySelector<HTMLElement>("[data-board-root]")!;
const state = document.querySelector("#initial-page");
if (state) hydrateRoot(root, <App page={JSON.parse(state.textContent!)} />);
else createRoot(root).render(<App />);

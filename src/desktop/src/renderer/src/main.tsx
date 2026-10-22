import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const convex = new ConvexReactClient(import.meta.env.CONVEX_URL);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ConvexAuthProvider client={convex}>
			<App />
		</ConvexAuthProvider>
	</StrictMode>,
);

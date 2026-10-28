import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const convex = new ConvexReactClient(import.meta.env.CONVEX_URL);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ConvexAuthProvider client={convex}>
			{/* Keeps data live for a minute after a view closes, so switching back is instant without
			    leaving every chat you opened re-running on the server. */}
			<ConvexQueryCacheProvider expiration={60_000}>
				<App />
			</ConvexQueryCacheProvider>
		</ConvexAuthProvider>
	</StrictMode>,
);

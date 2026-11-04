import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { MantineProvider } from "@mantine/core";
import { ConvexReactClient } from "convex/react";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const convex = new ConvexReactClient(import.meta.env.CONVEX_URL);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{/* For the popovers and dialogs (`views/chat/common.tsx`), which bring no styles of their own. */}
		<MantineProvider>
			<ConvexAuthProvider client={convex}>
				{/* Keeps data live for a minute after a view closes, so switching back is instant without
				    leaving every chat you opened re-running on the server. */}
				<ConvexQueryCacheProvider expiration={60_000}>
					<App />
				</ConvexQueryCacheProvider>
			</ConvexAuthProvider>
		</MantineProvider>
	</StrictMode>,
);

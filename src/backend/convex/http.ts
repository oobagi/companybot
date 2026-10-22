import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { callback } from "./oauth";

const http = httpRouter();
auth.addHttpRoutes(http);
http.route({ path: "/oauth/callback", method: "GET", handler: callback });

export default http;

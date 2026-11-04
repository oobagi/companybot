import { MantineProvider } from "@mantine/core";
import { createElement, type ReactNode } from "react";

/**
 * A piece of the app for a test, inside what main.tsx puts around the app (popovers and dialogs
 * need it), less the style tags it adds, which tests don't look at.
 */
export const inApp = (node: ReactNode) => createElement(MantineProvider, { withCssVariables: false, withGlobalClasses: false }, node);

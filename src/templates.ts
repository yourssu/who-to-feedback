import nunjucks from "nunjucks";
import { resolve } from "node:path";
import { configureTemplates } from "./template-common";
export * from "./template-common";
export { validateCustomTemplate, renderCustom } from "./custom-template";
export const templates: nunjucks.Environment = configureTemplates(
  new nunjucks.Environment(
    new nunjucks.FileSystemLoader(resolve("core/templates"), {
      noCache: process.env.NODE_ENV !== "production",
    }),
    { autoescape: true },
  ),
  nunjucks,
);

import nunjucks from "nunjucks/browser/nunjucks-slim.js";
import { TemplateLoader } from "./template-loader";
import { configureTemplates } from "../template-common";
export * from "../template-common";
export { validateCustomTemplate, renderCustom } from "../custom-template";
export const templates = configureTemplates(
  new nunjucks.Environment(new TemplateLoader(), { autoescape: true }),
  nunjucks,
);

import nunjucks from "nunjucks/browser/nunjucks-slim.js";
import compiled from "./generated/templates.js";
export class TemplateLoader extends nunjucks.Loader {
  getSource(name: string) {
    const obj = (compiled as Record<string, unknown>)[name];
    return obj
      ? { src: { type: "code", obj }, path: name, noCache: false }
      : null;
  }
}

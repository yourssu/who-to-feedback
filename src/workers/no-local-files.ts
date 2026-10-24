const unavailable = (): never => {
  throw new Error(
    "Workers report resources must be loaded from bindings before rendering",
  );
};
export const localFontBytes = unavailable;
export const fontData = unavailable;
export const imageData = unavailable;

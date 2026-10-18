import "./draftProjectName.css";

// Upstream sizes the name with canvas measureText, which reads macOS's system font wider than the
// DOM lays it out, so every name looked like it overflowed and lost a few characters. Scaling the
// canvas widths so the full name matches its real DOM width keeps truncation for names that
// actually overflow.
const FIT_TOLERANCE_PX = 0.5;

export function domCalibratedMeasure(
  container: HTMLElement,
  value: string,
  context: CanvasRenderingContext2D,
): (text: string) => number {
  const measureCanvas = (text: string) => context.measureText(text).width;
  const canvasFullWidth = measureCanvas(value);
  // The first child is the invisible copy of the full name; clipping does not change its text box.
  const sizer = container.firstElementChild;
  if (!sizer || canvasFullWidth <= 0) return measureCanvas;

  const range = document.createRange();
  range.selectNodeContents(sizer);
  const domFullWidth = range.getBoundingClientRect().width;
  const availableWidth = container.getBoundingClientRect().width;
  const fullWidth =
    domFullWidth - availableWidth <= FIT_TOLERANCE_PX
      ? Math.min(domFullWidth, availableWidth)
      : domFullWidth;
  const scale = fullWidth / canvasFullWidth;
  return (text) => measureCanvas(text) * scale;
}

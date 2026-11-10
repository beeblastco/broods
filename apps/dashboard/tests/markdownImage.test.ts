import { describe, expect, test } from "bun:test";
import { MarkdownImage } from "../app/components/MarkdownImage";

describe("markdown images", () => {
  test("a remote image becomes a link, never an img", () => {
    const element = MarkdownImage({
      src: "https://example.com/pixel.png?q=1",
      alt: "chart",
    });

    expect(element?.type).toBe("a");
    expect(element?.props.href).toBe("https://example.com/pixel.png?q=1");
  });

  test("a protocol-relative or plain http image is a link too", () => {
    expect(MarkdownImage({ src: "//example.com/p.png" })?.type).toBe("a");
    expect(MarkdownImage({ src: "http://example.com/p.png" })?.type).toBe("a");
  });

  test("inline image data renders as an image", () => {
    const element = MarkdownImage({ src: "data:image/png;base64,AAAA" });

    expect(element?.type).toBe("img");
  });

  test("no source renders nothing", () => {
    expect(MarkdownImage({})).toBeNull();
    expect(MarkdownImage({ src: "" })).toBeNull();
  });
});

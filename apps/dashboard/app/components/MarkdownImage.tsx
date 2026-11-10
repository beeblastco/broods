import type { Components, ExtraProps } from "streamdown";

export const MARKDOWN_IMAGE_COMPONENTS: Components = { img: MarkdownImage };

// Markdown from a model can name any host, so only inline image data loads unasked.
export function MarkdownImage({
  src,
  alt,
}: React.ComponentProps<"img"> & ExtraProps): React.JSX.Element | null {
  if (typeof src !== "string" || src === "") return null;
  if (src.startsWith("data:image/") || src.startsWith("blob:")) {
    return (
      // oxlint-disable-next-line nextjs/no-img-element -- inline data: nothing to optimize
      <img src={src} alt={alt ?? ""} className="max-w-full rounded-md" />
    );
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="wrap-anywhere cursor-pointer font-medium text-primary underline"
    >
      {alt || src}
    </a>
  );
}

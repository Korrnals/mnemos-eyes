// The `inert` HTML attribute (ME-002): React 18's types (@types/react 18.3)
// do not declare it. This module augmentation teaches JSX the attribute with
// the ONLY value shape that is safe on React 18.
//
// React 18 stringifies unknown boolean props: `inert={false}` would render
// `inert="false"` — and per HTML boolean-attribute semantics the attribute's
// PRESENCE alone applies inert, so a boolean false would leave the subtree
// inert anyway. Pass "" (apply) or undefined (remove), never a boolean.
import type {} from "react";

declare module "react" {
  // The type parameter must stay literally `T`: interface merging across
  // declarations requires identical type parameters — hence this one-line
  // unused-var suppression.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    inert?: "" | undefined;
  }
}

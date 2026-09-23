// The `inert` HTML attribute (ME-002): React 18's types (@types/react 18.3)
// do not declare it. This module augmentation teaches JSX the attribute with
// the ONLY value shape that is safe on React 18.
//
// React 18 has no `inert` property mapping: BOTH boolean values are silently
// DROPPED (verified empirically on react-dom 18.3.1 — `inert={true}` renders
// nothing too), so `inert={someBoolean}` would disable this whole mechanism
// invisibly. Pass "" (attribute renders, subtree inert) or undefined
// (attribute removed), never a boolean.
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

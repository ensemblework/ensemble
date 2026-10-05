import { Mark, mergeAttributes } from "@tiptap/core";

/** Stable highlight. The id survives edits that do not delete the range. */
export const CommentMark = Mark.create({
  name: "comment",
  inclusive: false,
  excludes: "",
  addAttributes() {
    return {
      id: { default: null },
      commentId: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-comment-id": HTMLAttributes.id,
        class: "comment-anchor",
      }),
      0,
    ];
  },
});

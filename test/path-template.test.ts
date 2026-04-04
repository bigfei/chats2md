import assert from "node:assert/strict";
import test from "node:test";

import { CONVERSATION_PATH_TEMPLATE_PRESETS, resolveConversationNoteRelativePath } from "../src/path-template.ts";

test("resolveConversationNoteRelativePath applies date and slug placeholders", () => {
  const resolved = resolveConversationNoteRelativePath("{date}/{slug}", {
    title: "Hello World",
    updatedAt: "2026-04-04T10:20:30.000Z",
    conversationId: "conv-1",
    email: "user@example.com",
    userId: "user-1"
  });

  assert.equal(resolved, "2026-04-04/Hello-World.md");
});

test("resolveConversationNoteRelativePath applies email/user placeholders with fallbacks", () => {
  const resolved = resolveConversationNoteRelativePath("{email}/{user_id}/{slug}", {
    title: "Template Test",
    updatedAt: "2026-04-04T10:20:30.000Z",
    conversationId: "conv-2",
    email: "",
    userId: ""
  });

  assert.equal(resolved, "unknown-email/unknown-user/Template-Test.md");
});

test("resolveConversationNoteRelativePath rejects unsupported placeholders", () => {
  assert.throws(
    () => resolveConversationNoteRelativePath("{date}/{unknown}", {
      title: "Broken",
      updatedAt: "2026-04-04T10:20:30.000Z",
      conversationId: "conv-3",
      email: "x@example.com",
      userId: "u-1"
    }),
    /unsupported placeholder/
  );
});

test("resolveConversationNoteRelativePath rejects templates ending with .md", () => {
  assert.throws(
    () => resolveConversationNoteRelativePath("{date}/{slug}.md", {
      title: "Broken",
      updatedAt: "2026-04-04T10:20:30.000Z",
      conversationId: "conv-4",
      email: "x@example.com",
      userId: "u-1"
    }),
    /should not include the \.md extension/
  );
});

test("CONVERSATION_PATH_TEMPLATE_PRESETS exposes supported presets", () => {
  assert.deepEqual(CONVERSATION_PATH_TEMPLATE_PRESETS, [
    "{date}/{slug}",
    "{email}/{user_id}/{date}/{slug}",
    "{email}/{user_id}/{slug}"
  ]);
});

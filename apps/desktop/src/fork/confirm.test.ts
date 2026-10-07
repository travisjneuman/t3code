import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import type * as Electron from "electron";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { confirm } from "./confirm.ts";

describe("confirm", () => {
  it.effect("uses a native question dialog for prompts above remote views", () => {
    const showMessageBox = vi.fn(() =>
      Effect.succeed({ response: 1, checkboxChecked: false } as Electron.MessageBoxReturnValue),
    );

    return Effect.gen(function* () {
      const result = yield* confirm.handler("Install update?\n\nAny running tasks will stop.");

      assert.isTrue(result);
      assert.deepEqual(showMessageBox.mock.calls, [
        [
          {
            type: "question",
            title: "ndev.t3code",
            message: "Install update?",
            detail: "Any running tasks will stop.",
            buttons: ["Cancel", "Confirm"],
            cancelId: 0,
            defaultId: 1,
            noLink: true,
          },
        ],
      ]);
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronDialog.ElectronDialog)({
          showMessageBox,
        }),
      ),
    );
  });
});

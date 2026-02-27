# Attribution

This package vendors and adapts code from
[tus-node-server](https://github.com/tus/tus-node-server), which is licensed
under the MIT License.

## Vendored source packages

| Upstream package  | Local path                                                                                                                                    | Description                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `@tus/server`     | `src/core/server.ts`, `src/core/validator.ts`                                                                                                 | Core tus protocol dispatch, header validation        |
| `@tus/utils`      | `src/core/constants.ts`, `src/core/upload.ts`, `src/core/data-store.ts`, `src/core/metadata.ts`, `src/core/locker.ts`, `src/core/kv-store.ts` | Protocol models, error constants, locking, KV stores |
| `@tus/file-store` | `src/stores/file-store.ts`                                                                                                                    | Filesystem-backed upload storage                     |

## MIT License (tus-node-server)

```text
MIT License

Copyright (c) Transloadit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

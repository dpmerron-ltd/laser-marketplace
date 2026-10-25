# Controller boundary

The approved design contains millimetre vectors and cut/score assignments. `src/laser/planner.ts` produces a neutral `Plan`, with compensated paths, ordered operations, per-path settings and placements. Controller commands are never stored as the design source.

`src/laser/controllers/types.ts` defines an encoder adapter with `compile` and `inspect`. The registry in `controllers/index.ts` selects it from the job's frozen machine snapshot. Compiled output is decoded and compared with planned movement order, coordinates, speed, min/max power and air assist. Passes expand into repeated movements. A mismatch rejects the export.

`workshop/transports.ts` is a separate asynchronous boundary for upload and status. It deliberately has no start/jog/focus/pulse operation. The store verifies the file hashes, persists `transferring` before awaiting upload, and permits only one staged/active/uncertain sheet per machine. An exception or mismatching receipt moves the sheet to `needs_reconciliation`; no retry is automatic. Simulation is the only enabled transport. A capability flag in this module is an engineering qualification decision, not a checkbox users can toggle to bypass qualification.

## Change controllers

For the two built-in adapters, choose Simulation or Ruida RD in Machine & material. Machine edits increment its revision and invalidate material approval. Approve the revised profile and prepare a new job. Old jobs retain their original bytes; the UI retrieves those stored artifacts instead of re-encoding them.

To support another family:

1. Implement `ControllerAdapter` using the neutral `Sheet` and `Machine` contract. Add the controller ID to `machineSchema` and the adapter registry. Adapter-specific configuration belongs in a versioned machine configuration extension; design geometry is unchanged.
2. Implement independent decoding/inspection and conformance fixtures for settings, units, bounds, orientation, passes and closed-loop endpoints. Update the encoder version for any output-changing revision.
3. Implement a `WorkshopTransport` in the service registry. Establish its upload-only behaviour, error/acknowledgement semantics, filename mapping, storage limits and status behaviour on the target model. A physical controller may not return a file hash; document and verify the transport's integrity evidence before issuing a matching receipt.
4. Commission first articles and calibrated material settings on that actual machine. Enable the qualified transport only after its integration tests and hardware trials pass. Automatic start is outside the transport contract.

## Ruida codec status

`ruida.ts` is a restricted experimental absolute-vector RD encoder, not a general Ruida SDK. It uses millimetres converted to integer micrometres, 7-bit payload groups, 14-bit power, absolute moves/cuts, layer metadata, min/max laser-1 power, zero laser-2 power, per-operation air requests and an RD checksum. It uses the common `0x88` byte scrambling variant. Other variants (for example models using `0x11`) are not enabled.

Its file header includes RD program commands, including start-process metadata. **Never stream the resulting raw RD bytes to a live controller as an upload shortcut.** A validated file-storage protocol is required to distinguish uploading from executing. The service currently contains no Ruida network I/O.

The encoder and strict decoder have round-trip tests. On 25 October 2026 a fixture with nested contours, score/cut settings, mirrored X and two cut passes was independently decoded with **MeerK40t 0.9.9100**: 305 commands and 234 matching movements/settings. This establishes offline agreement for that fixture, not acceptance of the file header, orientation or behaviour by any physical model.

Protocol references: [MeerK40t RDJob encoder/decoder](https://github.com/meerk40t/meerk40t/blob/main/meerk40t/ruida/rdjob.py), [MeerK40t Ruida device](https://github.com/meerk40t/meerk40t/blob/main/meerk40t/ruida/device.py), and [Ruida protocol research](https://github.com/jnweiger/ruida-laser/blob/master/doc/protocol.md). The application contains an original TypeScript implementation; it does not incorporate the GPL reference implementation. MeerK40t is an optional pinned verification dependency, not an application runtime dependency.

### Reproduce the independent decode

```bash
npx esbuild scripts/ruida-fixture.ts --bundle --platform=node --format=esm --packages=external --outfile=dist-workshop/ruida-fixture.mjs
node dist-workshop/ruida-fixture.mjs
python3 -m pip download --no-deps meerk40t==0.9.9100 --dest /tmp/laser-meerk40t
python3 scripts/verify-ruida.py /tmp/laser-meerk40t/meerk40t-0.9.9100-py2.py3-none-any.whl
```

The helper uses the library's parser without constructing a device or transport. No machine connection is made.

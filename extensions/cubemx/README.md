# CubeMX extension

`cubemx` adapts the STM32CubeMX command-line interface for agent use. It does not model STM32 constraints: CubeMX remains the sole authority for pin, clock, DMA, interrupt, peripheral, and memory validity.

## Setup

Install STM32CubeMX from STMicroelectronics. The extension searches, in order:

1. `STM32CUBEMX_PATH` (an executable or installation directory)
2. `PATH` (`stm32cubemx`, `STM32CubeMX`, or `STM32CubeMX.exe`)
3. common and versioned Linux, macOS, and Windows installation locations

Set `STM32CUBE_REPOSITORY` if firmware packages are not under `~/STM32Cube/Repository`.

The CLI adapter uses the long-supported quiet script interface (`-q script`) and quoted, absolute, slash-normalized paths. It reads the installed database metadata rather than assuming one CubeMX release. Generation is blocked on a detected CubeMX, database, or firmware-package mismatch unless the caller explicitly acknowledges it.

## Actions

- `discover`: find `.ioc` files beneath the working directory.
- `inspect`: summarize MCU/package, versions, peripherals and their configuration, pins/labels, clock properties, DMA, NVIC, memory/MPU, and project settings.
- `query`: retrieve any exact raw property keys or key prefix. This is the detailed interface for every CubeMX setting, including complete pin, clock-tree, peripheral, DMA, NVIC, and memory configuration.
- `patch`: set or remove exact raw properties. It previews by default and preserves all unrelated bytes, comments, escaping, ordering, unknown fields, and line endings. Repeat with `apply: true` to write.
- `validate`: ask CubeMX to load the exact `.ioc` without generation. A process exit code alone is not accepted; the CLI must report `OK` and not `KO`.
- `generate`: require validation of the unchanged file, then run in an isolated project copy by default. Repeat with `preview: false` to apply to the project.

## Required workflow

1. `discover` and `inspect` the selected project.
2. `query` the exact property groups needed for the requested change.
3. Preview `patch`, review it, then apply it.
4. `validate` the resulting `.ioc` with CubeMX.
5. Preview `generate` and review every created, changed, and deleted file.
6. Apply generation only when requested, then run the reported Bazel follow-ups separately.

Generation checks working-directory containment, version/package mismatches, balanced `USER CODE` regions, symbolic links, and cancellation/timeouts. It refuses projects containing symbolic links because they can escape preview and rollback isolation. It snapshots the project, preserves repository-only files such as `BUILD`, `.gitignore`, `.bazelrc`, and lock files, and rolls back failed or unsafe applied generation. It never builds, flashes, debugs, or invokes CubeIDE/CubeProgrammer.

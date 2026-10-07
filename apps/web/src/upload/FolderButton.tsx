import { Button, FileButton } from "@mantine/core";
import { IconFolderUp } from "@tabler/icons-react";
import { useRef, type ComponentProps } from "react";
import { isIos } from "../offline/pwa";

/**
 * Whether the browser can pick a folder (`<input webkitdirectory>`). iOS knows the attribute but
 * only picks files, so the button is hidden there (SPEC §28.1).
 */
export function canPickFolder(): boolean {
  return (
    typeof HTMLInputElement !== "undefined" &&
    "webkitdirectory" in HTMLInputElement.prototype &&
    !isIos()
  );
}

// React passes unknown lower-case attributes through; the DOM types do not know them.
const folderInputProps = { webkitdirectory: "", directory: "" } as ComponentProps<"input">;

/** "Upload folder": picks a whole folder; the files keep their `webkitRelativePath`. */
export function FolderButton({
  label,
  onFiles,
  disabled,
  testId,
}: {
  label: string;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  testId: string;
}) {
  const reset = useRef<() => void>(null);
  if (!canPickFolder()) return null;
  return (
    <FileButton
      multiple
      resetRef={reset}
      onChange={(files) => {
        // Clear the input so picking the same folder again fires once more.
        reset.current?.();
        if (files.length > 0) onFiles(files);
      }}
      disabled={disabled}
      inputProps={folderInputProps}
    >
      {(props) => (
        <Button
          {...props}
          variant="default"
          size="compact-sm"
          h={44}
          disabled={disabled}
          leftSection={<IconFolderUp size={16} aria-hidden />}
          data-testid={testId}
        >
          {label}
        </Button>
      )}
    </FileButton>
  );
}

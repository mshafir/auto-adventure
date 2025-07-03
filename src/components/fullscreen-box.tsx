import { Box, type BoxProps } from "ink";
import { useStdoutDimensions } from "../hooks/use-stdout-dimensions.js";

export function FullscreenBox({
	children,
	...props
}: { children: React.ReactNode } & BoxProps) {
	const [columns, rows] = useStdoutDimensions();
	return (
		<Box flexDirection="column" width={columns} height={rows} {...props}>
			{children}
		</Box>
	);
}

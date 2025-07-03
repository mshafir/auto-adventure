import {
	Box,
	type BoxProps,
	type DOMElement,
	measureElement,
	Text,
	useStdout,
} from "ink";
import { useEffect, useRef, useState } from "react";

export interface Size {
	width: number;
	height: number;
}

export function MeasuringBox({
	children,
	...props
}: { children: (output: Size) => React.ReactNode } & BoxProps) {
	const ref = useRef<DOMElement>(null);
	const { stdout } = useStdout();
	const [size, setSize] = useState<Size | undefined>(undefined);

	useEffect(() => {
		const handler = () => ref.current && setSize(measureElement(ref.current));
		stdout.on("resize", handler);
		handler();
		return () => {
			stdout.off("resize", handler);
		};
	}, [stdout]);

	return (
		<Box ref={ref} {...props}>
			{size ? children(size) : <Text>Loading...</Text>}
		</Box>
	);
}

import { useStdout } from "ink";
import { useEffect, useState } from "react";

export function useStdoutDimensions(): [number, number] {
    const { stdout } = useStdout();
    const [dimensions, setDimensions] = useState<[number, number]>([stdout.columns, stdout.rows]);
  
    useEffect(() => {
      const handler = () => setDimensions([stdout.columns, stdout.rows]);
      stdout.on('resize', handler);
      return () => {
        stdout.off('resize', handler);
      };
    }, [stdout]);
  
    return dimensions;
  }
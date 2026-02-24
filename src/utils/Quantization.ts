/**
 * Utilities for quantization and dequantization of 3D data.
 * Used for aggressively optimizing spatial and memory performance of huge tile streams.
 */
export class Quantization {
    /**
     * Dequantizes an array of coordinates back to 32-bit floating point scale.
     * 
     * @param quantizedData The quantized integer data array.
     * @param min The local tile bounding box minimum for the coordinates.
     * @param max The local tile bounding box maximum for the coordinates.
     * @param isUint16 True if using uint16 (0 to 65535), False if using int16 (-32768 to 32767).
     * @returns A decoded Float32Array
     */
    public static dequantizePositions(
        quantizedData: Uint16Array | Int16Array,
        min: number[],
        max: number[],
        isUint16: boolean = true
    ): Float32Array {
        const floatData = new Float32Array(quantizedData.length);

        const rangeX = max[0] - min[0];
        const rangeY = max[1] - min[1];
        const rangeZ = max[2] - min[2];

        for (let i = 0; i < quantizedData.length; i += 3) {
            if (isUint16) {
                // Uint16 [0, 65535] → [0.0, 1.0]
                floatData[i] = min[0] + (quantizedData[i] / 65535.0) * rangeX;
                floatData[i + 1] = min[1] + (quantizedData[i + 1] / 65535.0) * rangeY;
                floatData[i + 2] = min[2] + (quantizedData[i + 2] / 65535.0) * rangeZ;
            } else {
                // Int16 [-32768, 32767] → [0.0, 1.0] by offsetting to unsigned range
                floatData[i] = min[0] + ((quantizedData[i] + 32768) / 65535.0) * rangeX;
                floatData[i + 1] = min[1] + ((quantizedData[i + 1] + 32768) / 65535.0) * rangeY;
                floatData[i + 2] = min[2] + ((quantizedData[i + 2] + 32768) / 65535.0) * rangeZ;
            }
        }

        return floatData;
    }
}

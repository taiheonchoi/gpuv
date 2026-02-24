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

        const denominator = isUint16 ? 65535.0 : 32767.0;

        for (let i = 0; i < quantizedData.length; i += 3) {
            // Apply quantization formula: (val / denominator) * range + min
            floatData[i] = min[0] + (quantizedData[i] / denominator) * rangeX;
            floatData[i + 1] = min[1] + (quantizedData[i + 1] / denominator) * rangeY;
            floatData[i + 2] = min[2] + (quantizedData[i + 2] / denominator) * rangeZ;
        }

        return floatData;
    }
}

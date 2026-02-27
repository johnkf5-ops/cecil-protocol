import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["fastembed", "@anush008/tokenizers", "onnxruntime-node"],
};

export default nextConfig;

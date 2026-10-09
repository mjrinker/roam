/* eslint-disable @typescript-eslint/no-explicit-any, @next/next/no-img-element -- stand-in for next/image used by the browser checks */
import * as React from "react";
export default function Image({ src, alt, fill, sizes, unoptimized, priority, ...rest }: any) { return <img src={typeof src === "string" ? src : ""} alt={alt} {...rest} />; }

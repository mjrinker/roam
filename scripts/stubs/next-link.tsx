/* eslint-disable @typescript-eslint/no-explicit-any -- stand-ins for next/link used by the browser checks */
import * as React from "react";
export default function Link({ href, children, ...rest }: any) { return <a href={href} {...rest}>{children}</a>; }

"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { LogOut } from "lucide-react";
import { api } from "@/lib/api";
import { clearBrowserTabSession } from "@/lib/tab-session";
import { Dialog } from "../ui";

export function SignOutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => {
    clearBrowserTabSession();
    client.clear();
    window.location.replace("/login");
  } });
  return <Dialog open={open} title="Sign out of Ensemble?" onClose={() => { if (!logout.isPending) onClose(); }} width={400}>
    <p className="text-[14px] text-muted">You can sign back in to continue with your pages and work.</p>
    {logout.error ? <p role="alert" className="mt-3 text-[13px] text-danger">{logout.error.message}</p> : null}
    <div className="mt-5 flex justify-end gap-2"><button type="button" className="btn" disabled={logout.isPending} onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={logout.isPending} onClick={() => logout.mutate()}>{logout.isPending ? "Signing out…" : "Sign out"}</button></div>
  </Dialog>;
}

export function SignOutButton() {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="btn" onClick={() => setOpen(true)}><LogOut size={12} />Sign out</button><SignOutDialog open={open} onClose={() => setOpen(false)} /></>;
}

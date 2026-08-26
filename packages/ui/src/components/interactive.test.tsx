import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from "./dialog.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu.js";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./select.js";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "./tooltip.js";
import { ToastProvider, Toast, ToastTitle, ToastClose, ToastViewport } from "./toast.js";

describe("Dialog accessibility", () => {
  it("opens, traps focus, closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Hello</DialogTitle>
          <button>Inside</button>
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true); // focus trapped inside

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger); // focus restored
  });
});

describe("DropdownMenu keyboard", () => {
  it("opens via keyboard and exposes menu/menuitem roles", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>One</DropdownMenuItem>
          <DropdownMenuItem>Two</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    screen.getByRole("button", { name: "Menu" }).focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });
});

describe("Select", () => {
  it("opens and lists options", async () => {
    const user = userEvent.setup();
    render(
      <Select defaultValue="a">
        <SelectTrigger aria-label="fruit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Apple</SelectItem>
          <SelectItem value="b">Banana</SelectItem>
        </SelectContent>
      </Select>,
    );
    await user.click(screen.getByLabelText("fruit"));
    expect(await screen.findByRole("option", { name: "Banana" })).toBeInTheDocument();
  });
});

describe("Tooltip + Toast", () => {
  it("Tooltip content renders when open", async () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>hover</TooltipTrigger>
          <TooltipContent>Tip text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    expect((await screen.findAllByText("Tip text")).length).toBeGreaterThan(0);
  });

  it("Toast renders when open", () => {
    render(
      <ToastProvider>
        <Toast open>
          <ToastTitle>Saved</ToastTitle>
          <ToastClose />
        </Toast>
        <ToastViewport />
      </ToastProvider>,
    );
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
});

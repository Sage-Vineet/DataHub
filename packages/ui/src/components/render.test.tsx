import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button.js";
import { Input } from "./input.js";
import { Label } from "./label.js";
import { Badge } from "./badge.js";
import { Skeleton } from "./skeleton.js";
import { Card, CardHeader, CardTitle, CardContent } from "./card.js";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./table.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs.js";

describe("primitives render with the app's tokens", () => {
  it("Button default uses the primary token", () => {
    render(<Button>Go</Button>);
    const btn = screen.getByRole("button", { name: "Go" });
    expect(btn.className).toContain("bg-primary");
    expect(btn.className).toContain("rounded-lg");
    expect(btn.className).toContain("text-white");
  });

  it("Button variants and sizes apply", () => {
    render(
      <>
        <Button variant="outline">O</Button>
        <Button variant="destructive">D</Button>
        <Button size="sm">S</Button>
      </>,
    );
    expect(screen.getByText("O").className).toContain("border-border");
    expect(screen.getByText("D").className).toContain("bg-negative");
    expect(screen.getByText("S").className).toContain("h-8");
  });

  it("Button asChild renders the child element", () => {
    render(
      <Button asChild>
        <a href="/x">link</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "link" });
    expect(link.className).toContain("bg-primary");
  });

  it("Input + Label render and associate", () => {
    render(
      <>
        <Label htmlFor="e">Email</Label>
        <Input id="e" placeholder="you@x.com" />
      </>,
    );
    expect(screen.getByText("Email").className).toContain("font-medium");
    expect(screen.getByPlaceholderText("you@x.com")).toBeInTheDocument();
  });

  it("Badge + Skeleton render", () => {
    const { container } = render(
      <>
        <Badge>New</Badge>
        <Skeleton className="h-4 w-10" />
      </>,
    );
    expect(screen.getByText("New").className).toContain("rounded-full");
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("Card composes header/content", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
        </CardHeader>
        <CardContent>Body</CardContent>
      </Card>,
    );
    expect(screen.getByText("Title").className).toContain("font-semibold");
    expect(screen.getByText("Body")).toBeInTheDocument();
  });

  it("Table renders rows and cells", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Ada</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Ada" })).toBeInTheDocument();
  });

  it("Tabs switches panels", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
        <TabsContent value="b">Panel B</TabsContent>
      </Tabs>,
    );
    expect(screen.getByText("Panel A")).toBeInTheDocument();
  });
});

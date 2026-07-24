import { useEffect, useState } from "react";
import type { Key, ReactNode } from "react";
import {
  Alert,
  Button,
  Checkbox,
  ConfigProvider,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tooltip,
  Tree,
  Typography,
  type TreeDataNode,
} from "antd";
import {
  ArrowUpOutlined,
  FileOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  HomeOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type {
  AttachmentSelectionKind,
  BrowseServerFilesResponse,
  ServerFileEntry,
  ValidatedAttachment,
} from "@brainstorm-agentic/protocol";
import {
  browseServerFiles,
  errorMessage,
  searchServerFiles,
  validateAttachments,
} from "../api";

const { DirectoryTree } = Tree;

const KIND_LABELS: Readonly<
  Record<Exclude<AttachmentSelectionKind, "web">, string>
> = {
  file: "files",
  folder: "folders",
  zip: "ZIP archives",
  image: "images",
  video: "videos",
  pdf: "PDF files",
};

export interface ServerFileExplorerProps {
  readonly kind: Exclude<AttachmentSelectionKind, "web">;
  readonly onClose: () => void;
  readonly onAttach: (
    attachments: readonly ValidatedAttachment[],
  ) => void;
}

interface ExplorerNode extends TreeDataNode {
  readonly path: string;
  readonly rootId: string;
  readonly entryKind: "file" | "folder";
  readonly searchText: string;
  children?: ExplorerNode[];
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function nodeTitle(
  entry: ServerFileEntry,
  showPath = false,
): ReactNode {
  return (
    <span className="antd-file-title" title={entry.path}>
      <span className="antd-file-name">{entry.name}</span>
      {showPath && (
        <span className="antd-file-path">{entry.path}</span>
      )}
      {entry.bytes !== undefined && (
        <span className="antd-file-size">{formatBytes(entry.bytes)}</span>
      )}
      {!entry.selectable && entry.kind === "file" && entry.reason && (
        <span className="antd-file-reason">{entry.reason}</span>
      )}
    </span>
  );
}

function toNodes(
  listing: BrowseServerFilesResponse,
): ExplorerNode[] {
  return entriesToNodes(listing.entries, listing.rootId);
}

function entriesToNodes(
  entries: readonly ServerFileEntry[],
  rootId: string,
  showPath = false,
): ExplorerNode[] {
  return entries.map((entry) => ({
    key: entry.path,
    path: entry.path,
    rootId,
    entryKind: entry.kind,
    searchText: entry.name.toLowerCase(),
    title: nodeTitle(entry, showPath),
    icon:
      entry.kind === "folder" ? (
        <FolderOutlined />
      ) : (
        <FileOutlined />
      ),
    isLeaf: entry.kind === "file",
    checkable: entry.selectable,
    selectable: false,
  }));
}

function replaceChildren(
  nodes: readonly ExplorerNode[],
  key: Key,
  children: ExplorerNode[],
): ExplorerNode[] {
  return nodes.map((node) =>
    node.key === key
      ? { ...node, children }
      : node.children
        ? {
            ...node,
            children: replaceChildren(node.children, key, children),
          }
        : node,
  );
}

export function ServerFileExplorer({
  kind,
  onClose,
  onAttach,
}: ServerFileExplorerProps) {
  const [listing, setListing] =
    useState<BrowseServerFilesResponse | null>(null);
  const [treeData, setTreeData] = useState<ExplorerNode[]>([]);
  const [checkedKeys, setCheckedKeys] = useState<Key[]>([]);
  const [pathDraft, setPathDraft] = useState("");
  const [search, setSearch] = useState("");
  const [searchNodes, setSearchNodes] = useState<ExplorerNode[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<
    readonly ValidatedAttachment[]
  >([]);

  const loadDirectory = async (
    root?: string,
    path?: string,
  ): Promise<void> => {
    setLoading(true);
    setError(null);
    setInvalid([]);
    try {
      const next = await browseServerFiles(kind, root, path);
      setListing(next);
      setTreeData(toNodes(next));
      // Checked entries from a previous directory are otherwise invisible
      // but still submitted (e.g. Desktop remains selected after navigating
      // up to Home). A navigation starts a fresh visible selection.
      setCheckedKeys([]);
      setPathDraft(next.currentPath);
      setSearch("");
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDirectory();
    // The parent remounts this component whenever kind changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const query = search.trim();
    if (query.length < 2 || !listing) {
      setSearchNodes(null);
      setSearchTruncated(false);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void searchServerFiles(
        kind,
        query,
        listing.rootId,
        listing.currentPath,
      )
        .then((result) => {
          if (cancelled) return;
          setSearchNodes(
            entriesToNodes(result.entries, result.rootId, true),
          );
          setSearchTruncated(result.truncated);
        })
        .catch((searchError) => {
          if (!cancelled) setError(errorMessage(searchError));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [kind, listing, search]);

  const serverSearchActive = search.trim().length >= 2;
  const visibleTree =
    serverSearchActive ? (searchNodes ?? []) : treeData;

  const loadChildren = async (node: ExplorerNode): Promise<void> => {
    if (node.entryKind !== "folder" || node.children) return;
    try {
      const nested = await browseServerFiles(
        kind,
        node.rootId,
        node.path,
      );
      const children = toNodes(nested);
      if (serverSearchActive) {
        setSearchNodes((current) =>
          current
            ? replaceChildren(current, node.key, children)
            : current,
        );
      } else {
        setTreeData((current) =>
          replaceChildren(current, node.key, children),
        );
      }
    } catch (loadError) {
      setError(errorMessage(loadError));
      throw loadError;
    }
  };

  const toggleCurrentFolder = (checked: boolean): void => {
    if (!listing) return;
    setCheckedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(listing.currentPath);
      else next.delete(listing.currentPath);
      return [...next];
    });
  };

  const validateAndAttach = async (): Promise<void> => {
    if (checkedKeys.length === 0 || validating) return;
    setValidating(true);
    setError(null);
    try {
      const response = await validateAttachments(
        kind,
        checkedKeys.map(String),
      );
      const failures = response.attachments.filter(
        (attachment) => !attachment.valid,
      );
      setInvalid(failures);
      if (failures.length > 0) return;
      onAttach(response.attachments);
      onClose();
    } catch (validationError) {
      setError(errorMessage(validationError));
    } finally {
      setValidating(false);
    }
  };

  return (
    <ConfigProvider
      componentSize="small"
      theme={{
        token: {
          fontSize: 12,
          controlHeight: 26,
          borderRadius: 6,
        },
      }}
    >
      <Modal
        open
        width={780}
        title={
          <Space size={6}>
            <FolderOpenOutlined />
            <span>Select {KIND_LABELS[kind]}</span>
          </Space>
        }
        onCancel={onClose}
        destroyOnHidden
        maskClosable={!validating}
        keyboard={!validating}
        footer={[
          <Typography.Text key="count" type="secondary">
            {checkedKeys.length} selected
          </Typography.Text>,
          <Button key="cancel" onClick={onClose}>
            Cancel
          </Button>,
          <Button
            key="attach"
            type="primary"
            loading={validating}
            disabled={checkedKeys.length === 0}
            onClick={() => void validateAndAttach()}
          >
            Validate & attach
          </Button>,
        ]}
        className="server-directory-modal"
      >
        {listing && (
          <div className="server-directory-toolbar">
            {listing.roots.length > 1 && (
              <Select
                value={listing.rootId}
                className="server-root-select"
                options={listing.roots.map((root) => ({
                  value: root.id,
                  label: root.label,
                }))}
                onChange={(root) => {
                  setCheckedKeys([]);
                  void loadDirectory(root);
                }}
              />
            )}
          <Tooltip title="Root folder">
            <Button
              icon={<HomeOutlined />}
              onClick={() =>
                void loadDirectory(listing.rootId)
              }
            />
          </Tooltip>
          <Tooltip title="Parent folder">
            <Button
              icon={<ArrowUpOutlined />}
              disabled={!listing.parentPath}
              onClick={() =>
                void loadDirectory(
                  listing.rootId,
                  listing.parentPath,
                )
              }
            />
          </Tooltip>
          <Tooltip title="Refresh">
            <Button
              icon={<ReloadOutlined />}
              onClick={() =>
                void loadDirectory(
                  listing.rootId,
                  listing.currentPath,
                )
              }
            />
          </Tooltip>
          </div>
        )}

      {listing && (
        <Input.Search
          value={pathDraft}
          className="server-address-bar"
          enterButton="Go"
          aria-label="server folder path"
          onChange={(event) => setPathDraft(event.target.value)}
          onSearch={(path) =>
            void loadDirectory(listing.rootId, path)
          }
        />
      )}

      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder="Search this server folder and subfolders"
        value={search}
        className="server-tree-search"
        onChange={(event) => setSearch(event.target.value)}
      />
      {searchTruncated && (
        <Typography.Text type="secondary">
          Showing the first 100 matches.
        </Typography.Text>
      )}

      {kind === "folder" && listing && (
        <Checkbox
          checked={checkedKeys.includes(listing.currentPath)}
          onChange={(event) =>
            toggleCurrentFolder(event.target.checked)
          }
          className="server-current-folder"
        >
          Select current folder:{" "}
          <Typography.Text code>
            {listing.currentPath}
          </Typography.Text>
        </Checkbox>
      )}

      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          closable
          onClose={() => setError(null)}
        />
      )}

      <Spin
        spinning={loading || searching}
        tip={
          searching
            ? "Searching server folders…"
            : "Reading server directory…"
        }
      >
        <div className="server-directory-tree">
          {!loading && !searching && visibleTree.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                serverSearchActive
                  ? "No server entries match this search"
                  : "This directory is empty"
              }
            />
          ) : (
            <DirectoryTree<ExplorerNode>
              multiple
              checkable
              checkStrictly
              showIcon
              blockNode
              expandAction="click"
              checkedKeys={checkedKeys}
              treeData={visibleTree}
              loadData={loadChildren}
              height={300}
              onCheck={(keys) => {
                const checked = Array.isArray(keys)
                  ? keys
                  : keys.checked;
                setCheckedKeys(checked);
                setInvalid([]);
              }}
            />
          )}
        </div>
      </Spin>

        {invalid.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={`${invalid.length} selected item${invalid.length === 1 ? "" : "s"} failed validation`}
          description={
            <ul className="server-invalid-list">
              {invalid.map((item) => (
                <li key={item.path}>
                  <Typography.Text code>{item.path}</Typography.Text>
                  {" — "}
                  {item.reason}
                </li>
              ))}
            </ul>
          }
        />
        )}
      </Modal>
    </ConfigProvider>
  );
}

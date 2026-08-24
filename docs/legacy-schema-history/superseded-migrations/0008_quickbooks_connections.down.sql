-- Reverse of 0008.
--
-- Dropping this disconnects every company from QuickBooks. The tokens go with
-- it and cannot be recovered — each client has to re-authorise through Intuit,
-- which needs someone with QuickBooks admin rights at the client, not here.

DROP TABLE IF EXISTS quickbooks_connections;

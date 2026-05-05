CREATE TABLE IF NOT EXISTS username (
  user_id INT NOT NULL,
  username VARCHAR(255) NOT NULL,
  password VARCHAR(255) NOT NULL,
  sex VARCHAR(32) NOT NULL,
  order_id INT NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_order_id (order_id)
);

INSERT INTO username (user_id, username, password, sex)
VALUES
  (1, 'sparkle', 'sparkle@123', 'f'),
  (2, 'stormhoof', 'stormhoof@123', 'm'),
  (3, 'rainbow', 'rainbow@123', 'f'),
  (4, 'midnight', 'midnight@123', 'm')
ON DUPLICATE KEY UPDATE
  username = VALUES(username),
  password = VALUES(password),
  sex = VALUES(sex);
